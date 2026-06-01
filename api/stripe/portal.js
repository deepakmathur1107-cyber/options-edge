// api/stripe/portal.js
const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function verifyClerkToken(token) {
  const res = await fetch('https://api.clerk.com/v1/tokens/verify', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
    },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error('Token verification failed')
  return res.json()
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' })

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await verifyClerkToken(token)
    clerkUserId   = payload.sub
    if (!clerkUserId) throw new Error('No sub')
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }

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
    return res.status(500).json({ error: e.message })
  }
}
