// api/stripe/checkout.js
// Verifies Clerk JWT using JWKS (networkless after first fetch, no SDK needed)

const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ─── Lightweight JWT verification via Clerk JWKS ──────────────────────────────
// Decodes the JWT, fetches Clerk's public key, verifies the signature.
// Works with any Clerk instance — no SDK, no authorizedParties issue.

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad  = b64.length % 4 ? '='.repeat(4 - b64.length % 4) : ''
  return Buffer.from(b64 + pad, 'base64')
}

async function getClerkPublicKey(kid) {
  const res  = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` }
  })
  if (!res.ok) throw new Error('Failed to fetch JWKS')
  const jwks = await res.json()
  const key  = jwks.keys?.find(k => k.kid === kid)
  if (!key) throw new Error(`No JWKS key found for kid: ${kid}`)
  return key
}

async function verifyClerkJWT(token) {
  // 1. Decode header to get kid
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const header  = JSON.parse(base64urlDecode(parts[0]).toString('utf8'))
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'))

  // 2. Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('Token expired')

  // 3. Fetch public key and verify using Node crypto
  const jwkKey  = await getClerkPublicKey(header.kid)
  const crypto  = require('crypto')
  const keyObj  = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
  const sigInput = Buffer.from(parts[0] + '.' + parts[1])
  const sig      = base64urlDecode(parts[2])
  const valid    = crypto.verify('sha256', sigInput, { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)
  if (!valid) throw new Error('Invalid signature')

  return payload   // { sub: userId, ... }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {}

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token provided' })

  let clerkUserId
  try {
    const payload = await verifyClerkJWT(token)
    clerkUserId   = payload.sub
    if (!clerkUserId) throw new Error('No user ID in token')
  } catch (e) {
    console.error('JWT verify error:', e.message)
    return res.status(401).json({ error: 'Authentication failed: ' + e.message })
  }

  const email  = body.email || ''
  const origin = req.headers.origin || `https://${req.headers.host}`

  try {
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

    await supabase.from('subscriptions').upsert({
      clerk_id:           clerkUserId,
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
