const Stripe        = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const { getAuth }   = require('../_lib/auth')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Authentication failed' })

  try {
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('clerk_id', clerkId)
      .maybeSingle()

    // No record at all — brand new user, trial eligible
    if (!existingSub?.stripe_customer_id) {
      return res.status(200).json({ eligible: true })
    }

    // Has a subscription_id recorded — trial was used
    if (existingSub.stripe_subscription_id) {
      return res.status(200).json({ eligible: false })
    }

    // Has a customer but no sub_id yet — double-check Stripe directly
    const subs = await stripe.subscriptions.list({
      customer: existingSub.stripe_customer_id,
      limit: 10,
      status: 'all',
    })
    const trialEverUsed = subs.data.some(
      s => s.trial_start !== null || s.trial_end !== null
    )

    return res.status(200).json({ eligible: !trialEverUsed })
  } catch (e) {
    console.error('Trial status error:', e.message)
    return res.status(200).json({ eligible: false })
  }
}
