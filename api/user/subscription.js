// api/user/subscription.js
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

  // Admins always get active status — no trial logic needed
  if (isAdmin) {
    return res.status(200).json({
      status:         'active',
      plan:           'admin',
      isAdmin:        true,
      trial_eligible: false,
    })
  }

  const supaUrl = process.env.SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return res.status(200).json({ status: 'active', plan: 'pro', trial_eligible: false })
  }

  const supabase = createClient(supaUrl, supaKey)
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end, stripe_subscription_id, stripe_customer_id')
    .eq('clerk_id', clerkId)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })

  // Brand new user — no Supabase row at all, definitely trial eligible
  if (!data) {
    return res.status(200).json({
      status:         'inactive',
      plan:           null,
      trial_eligible: true,
    })
  }

  let status = data.status
  let trialEligible = false

  // ── Stripe fallback: fix race condition between checkout redirect and webhook
  // Also used here to determine trial eligibility from Stripe's authoritative record
  if (data.stripe_customer_id) {
    try {
      const Stripe = require('stripe')
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
      const allSubs = await stripe.subscriptions.list({
        customer: data.stripe_customer_id,
        limit: 10,
        status: 'all',
      })

      // Fix pending/inactive status if Stripe shows active/trialing
      if (status === 'pending' || status === 'inactive') {
        const activeSub = allSubs.data.find(
          s => s.status === 'active' || s.status === 'trialing'
        )
        if (activeSub) {
          status = activeSub.status
          const periodEnd = new Date(activeSub.current_period_end * 1000).toISOString()
          await supabase.from('subscriptions').upsert({
            clerk_id:               clerkId,
            stripe_subscription_id: activeSub.id,
            status,
            current_period_end:     periodEnd,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'clerk_id' })
        }
      }

      // Trial eligible only if no subscription has ever had a trial
      const trialEverUsed = allSubs.data.some(
        s => s.trial_start !== null || s.trial_end !== null
      )
      // Also ineligible if they have any subscription record at all (even cancelled)
      const everSubscribed = allSubs.data.length > 0 || !!data.stripe_subscription_id
      trialEligible = !trialEverUsed && !everSubscribed

    } catch (e) {
      console.warn('Stripe check failed:', e.message)
      // Safe default — don't grant trial if check errors
      trialEligible = false
    }
  }

  // ── Period expiry check — 1hr grace for webhook delivery delay
  const periodEnd = data.current_period_end ? new Date(data.current_period_end) : null
  const grace     = 60 * 60 * 1000
  if ((status === 'active' || status === 'trialing') && periodEnd && periodEnd < new Date(Date.now() - grace)) {
    status = 'expired'
  }

  return res.status(200).json({
    status,
    plan:               data.plan,
    current_period_end: data.current_period_end,
    subscription_id:    data.stripe_subscription_id,
    trial_eligible:     trialEligible,
  })
}
