// api/stripe/portal.js
const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad  = b64.length % 4 ? '='.repeat(4 - b64.length % 4) : ''
  return Buffer.from(b64 + pad, 'base64')
}
async function verifyClerkJWT(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const header  = JSON.parse(base64urlDecode(parts[0]).toString('utf8'))
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'))
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('Token expired')
  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: 'Bearer ' + process.env.CLERK_SECRET_KEY }
  })
  if (!jwksRes.ok) throw new Error('Failed to fetch JWKS')
  const jwks   = await jwksRes.json()
  const jwkKey = jwks.keys?.find(k => k.kid === header.kid)
  if (!jwkKey) throw new Error('No matching JWKS key')
  const crypto = require('crypto')
  const keyObj = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
  const valid  = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(parts[2]))
  if (!valid) throw new Error('Invalid signature')
  return payload
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
    const payload = await verifyClerkJWT(token)
    clerkUserId   = payload.sub
    if (!clerkUserId) throw new Error('No user ID')
  } catch (e) {
    return res.status(401).json({ error: 'Authentication failed: ' + e.message })
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('clerk_id', clerkUserId)
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
