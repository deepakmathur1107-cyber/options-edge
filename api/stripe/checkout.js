// api/stripe/checkout.js
const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ─── Verify Clerk JWT without SDK ────────────────────────────────────────────
// Uses Clerk's own verification endpoint — no azp/authorizedParties issue
async function verifyClerkToken(token) {
  const res = await fetch('https://api.clerk.com/v1/tokens/verify', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
    },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error('Clerk verify failed: ' + err)
  }
  return res.json()   // returns { sub, ... }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }

  // Verify Clerk JWT
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token provided' })

  let clerkUserId
  try {
    const payload = await verifyClerkToken(token)
    clerkUserId   = payload.sub
    if (!clerkUserId) throw new Error('No sub in token')
  } catch (e) {
    console.error('Token verify error:', e.message)
    return res.status(401).json({ error: 'Invalid token: ' + e.message })
  }

  const email  = body.email || ''
  const origin = req.headers.origin || `https://${req.headers.host}`

  try {
    // Reuse existing Stripe customer if present
    let stripeCustomerId
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('clerk_id', clerkUserId)
      .maybeSingle()

    if (existingSub?.stripe_customer_id) {
      stripeCustomerId = existingSub.stripe_customer_id
    } else {
      const customer   = await stripe.customers.create({
        email,
        metadata: { clerk_id: clerkUserId },
      })
      stripeCustomerId = customer.id
    }

    // Create Stripe Checkout session with 7-day trial
    const session = await stripe.checkout.sessions.create({
      customer:   stripeCustomerId,
      mode:       'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID_PRO, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { clerk_id: clerkUserId },
      },
      success_url: `${origin}/app?sub=success`,
      cancel_url:  `${origin}/app`,
      allow_promotion_codes:      true,
      billing_address_collection: 'required',
      customer_email: existingSub?.stripe_customer_id ? undefined : email,
    })

    // Store pending record so webhook can find the clerk_id
    await supabase.from('subscriptions').upsert({
      clerk_id:           clerkUserId,
      stripe_customer_id: stripeCustomerId,
      status:             'pending',
      plan:               'pro',
    }, { onConflict: 'clerk_id' })

    return res.status(200).json({ url: session.url })

  } catch (e) {
    console.error('Stripe checkout error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
