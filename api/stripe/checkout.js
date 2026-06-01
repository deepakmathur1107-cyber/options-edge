// api/stripe/checkout.js
// Creates a Stripe Checkout session for the Pro plan with a 7-day free trial.
// Returns the checkout URL for the frontend to redirect to.

const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const { createClerkClient } = require('@clerk/backend')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const clerk    = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Parse body
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }

  // Verify Clerk JWT
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await clerk.verifyToken(token)
    clerkUserId = payload.sub
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  const email = body.email || ''
  const origin = req.headers.origin || `https://${req.headers.host}`

  try {
    // Get or create Stripe customer — reuse existing if already subscribed before
    let stripeCustomerId
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('clerk_id', clerkUserId)
      .maybeSingle()

    if (existingSub?.stripe_customer_id) {
      stripeCustomerId = existingSub.stripe_customer_id
    } else {
      const customer = await stripe.customers.create({
        email,
        metadata: { clerk_id: clerkUserId },
      })
      stripeCustomerId = customer.id
    }

    // Create checkout session with 7-day trial
    const session = await stripe.checkout.sessions.create({
      customer:    stripeCustomerId,
      mode:        'subscription',
      line_items:  [{ price: process.env.STRIPE_PRICE_ID_PRO, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { clerk_id: clerkUserId },
      },
      success_url: `${origin}/app?sub=success`,
      cancel_url:  `${origin}/app`,
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      customer_email: existingSub?.stripe_customer_id ? undefined : email,
    })

    // Upsert a pending subscription record so webhook has a clerk_id to update
    await supabase.from('subscriptions').upsert({
      clerk_id:           clerkUserId,
      stripe_customer_id: stripeCustomerId,
      status:             'pending',
      plan:               'pro',
    }, { onConflict: 'clerk_id' })

    return res.status(200).json({ url: session.url })

  } catch (e) {
    console.error('Stripe checkout error:', e)
    return res.status(500).json({ error: e.message })
  }
}
