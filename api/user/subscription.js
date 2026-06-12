// api/user/subscription.js
// Consolidated: uses shared getAuth from _lib/auth.js (no more duplicate JWT verification).
const { createClient } = require('@supabase/supabase-js')
const { getAuth }      = require('../_lib/auth')

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const { clerkId, isAdmin, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Auth failed' })

  // ── Admin always gets active status ───────────────────────────────────────
  if (isAdmin) {
    return res.status(200).json({ status: 'active', plan: 'admin', isAdmin: true })
  }

  // ── Regular user — check Supabase ─────────────────────────────────────────
  const supaUrl = process.env.SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return res.status(200).json({ status: 'active', plan: 'pro' }) // dev mode fallback
  }

  const supabase = createClient(supaUrl, supaKey)
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end, stripe_subscription_id, stripe_customer_id')
    .eq('clerk_id', clerkId)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  if (!data)  return res.status(200).json({ status: 'inactive', plan: null })

  let status = data.status

  // Check Stripe directly if pending (race condition between checkout redirect and webhook)
  if ((status === 'pending' || status === 'inactive') && data.stripe_customer_id) {
    try {
      const Stripe = require('stripe')
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
      const subs   = await stripe.subscriptions.list({
        customer: data.stripe_customer_id, limit: 5, status: 'all'
      })
      const active = subs.data.find(s => s.status === 'active' || s.status === 'trialing')
      if (active) {
        status = active.status
        const periodEnd = new Date(active.current_period_end * 1000).toISOString()
        await supabase.from('subscriptions').upsert({
          clerk_id:               clerkId,
          stripe_subscription_id: active.id,
          status,
          current_period_end:     periodEnd,
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })
      }
    } catch (e) {
      console.warn('Stripe fallback check failed:', e.message)
    }
  }

  // Period expiry check — add 1hr grace for webhook delivery delay
  const periodEnd = data.current_period_end ? new Date(data.current_period_end) : null
  const grace     = 60 * 60 * 1000  // 1 hour grace period
  if ((status === 'active' || status === 'trialing') && periodEnd && periodEnd < new Date(Date.now() - grace)) {
    status = 'expired'
  }

  return res.status(200).json({
    status,
    plan:               data.plan,
    current_period_end: data.current_period_end,
    subscription_id:    data.stripe_subscription_id,
  })
}
