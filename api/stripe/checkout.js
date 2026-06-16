// api/stripe/checkout.js
const Stripe        = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const { getAuth }   = require('../_lib/auth')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' })

  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Authentication failed' })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {}
  const email  = body.email || ''
  const origin = req.headers.origin || `https://${req.headers.host}`

  try {
    let stripeCustomerId
    let trialEverUsed = false

    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('clerk_id', clerkId)
      .maybeSingle()

    if (existingSub?.stripe_customer_id) {
      stripeCustomerId = existingSub.stripe_customer_id

      // Check all subscriptions for this customer on Stripe
      const allSubs = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        limit: 10,
        status: 'all',
      })

      // GUARD 1: Block if already has an active or trialing subscription
      const alreadyActive = allSubs.data.some(
        s => s.status === 'active' || s.status === 'trialing'
      )
      if (alreadyActive) {
        return res.status(400).json({
          error: 'You already have an active subscription. Use "Manage subscription" below to make changes.',
          already_subscribed: true,
        })
      }

      // GUARD 2: Check if trial was ever used on any past or present subscription
      if (existingSub.stripe_subscription_id) {
        trialEverUsed = true
      } else {
        trialEverUsed = allSubs.data.some(
          s => s.trial_start !== null || s.trial_end !== null
        )
      }
    } else {
      // Brand new customer — create in Stripe
      const customer = await stripe.customers.create({
        email,
        metadata: { clerk_id: clerkId },
      })
      stripeCustomerId = customer.id
    }

    // Build subscription_data — only add trial if eligible
    const subscriptionData = {
      // Pass clerk_id at subscription level for webhook.subscription.created
      metadata: { clerk_id: clerkId },
    }
    if (!trialEverUsed) {
      subscriptionData.trial_period_days = 7
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode:     'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID_PRO, quantity: 1 }],
      subscription_data: subscriptionData,
      // Pass clerk_id at SESSION level so checkout.session.completed webhook
      // can identify the user immediately without a Supabase lookup
      metadata: { clerk_id: clerkId },
      success_url: `${origin}/app?sub=success`,
      cancel_url:  `${origin}/app`,
      allow_promotion_codes:      true,
      billing_address_collection: 'required',
    })

    // Write pending row so webhook can find clerk_id via customer lookup if needed
    await supabase.from('subscriptions').upsert({
      clerk_id:           clerkId,
      stripe_customer_id: stripeCustomerId,
      status:             'pending',
      plan:               'pro',
    }, { onConflict: 'clerk_id' })

    return res.status(200).json({ url: session.url, trial: !trialEverUsed })
  } catch (e) {
    console.error('Checkout error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
