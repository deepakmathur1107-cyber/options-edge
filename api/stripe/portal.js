// api/stripe/portal.js
// Creates a Stripe Customer Portal session so users can manage their subscription,
// update payment method, or cancel — all on Stripe's hosted UI.

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

  // Verify Clerk JWT
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await clerk.verifyToken(token)
    clerkUserId = payload.sub
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  // Get Stripe customer ID from Supabase
  const { data, error } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('clerk_id', clerkUserId)
    .maybeSingle()

  if (error || !data?.stripe_customer_id) {
    return res.status(404).json({ error: 'No subscription found. Please subscribe first.' })
  }

  try {
    const origin  = req.headers.origin || `https://${req.headers.host}`
    const session = await stripe.billingPortal.sessions.create({
      customer:   data.stripe_customer_id,
      return_url: `${origin}/app`,
    })
    return res.status(200).json({ url: session.url })
  } catch (e) {
    console.error('Portal error:', e)
    return res.status(500).json({ error: e.message })
  }
}
