// api/stripe/checkout.js
// Consolidated: uses shared getAuth from _lib/auth.js (no more duplicate JWT verification).
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
    // Reuse existing Stripe customer if one exists
    let stripeCustomerId
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('clerk_id', clerkId)
      .maybeSingle()

    if (existingSub?.stripe_customer_id) {
      stripeCustomerId = existingSub.stripe_customer_id
    } else {
      const customer   = await stripe.customers.create({
        email,
        metadata: { clerk_id: clerkId },
      })
      stripeCustomerId = customer.id
    }

    const session = await stripe.checkout.sessions.create({
      customer:   stripeCustomerId,
      mode:       'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID_PRO, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { clerk_id: clerkId },
      },
      success_url: `${origin}/app?sub=success`,
      cancel_url:  `${origin}/app`,
      allow_promotion_codes:      true,
      billing_address_collection: 'required',
    })

    await supabase.from('subscriptions').upsert({
      clerk_id:           clerkId,
      stripe_customer_id: stripeCustomerId,
      status:             'pending',
      plan:               'pro',
    }, { onConflict: 'clerk_id' })

    return res.status(200).json({ url: session.url })

  } catch (e) {
    console.error('Checkout error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
