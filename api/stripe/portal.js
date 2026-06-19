// api/stripe/portal.js
// Consolidated: uses shared getAuth from _lib/auth.js (no more duplicate JWT verification).
const Stripe        = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const { getAuth }   = require('../_lib/auth')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' })

  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Authentication failed' })

  const { data, error } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('clerk_id', clerkId)
    .maybeSingle()

  if (error || !data?.stripe_customer_id) {
    return res.status(404).json({ error: 'No subscription found.' })
  }

  try {
    const origin  = req.headers.origin || 'https://' + req.headers.host
    const session = await stripe.billingPortal.sessions.create({
      customer:   data.stripe_customer_id,
      return_url: origin + '/app',
    })
    return res.status(200).json({ url: session.url })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
