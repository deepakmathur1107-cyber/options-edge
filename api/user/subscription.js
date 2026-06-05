// api/user/subscription.js
const { createClient } = require('@supabase/supabase-js')

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

function b64d(str) {
  const b64 = str.replace(/-/g,'+').replace(/_/g,'/')
  const pad  = b64.length%4 ? '='.repeat(4-b64.length%4) : ''
  return Buffer.from(b64+pad,'base64')
}
async function verifyClerkJWT(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const header  = JSON.parse(b64d(parts[0]).toString('utf8'))
  const payload = JSON.parse(b64d(parts[1]).toString('utf8'))
  if (payload.exp && Date.now()/1000 > payload.exp) throw new Error('Token expired')
  const clerkKey = process.env.CLERK_SECRET_KEY
  const jwksRes  = await fetch('https://api.clerk.com/v1/jwks',
    { headers: { Authorization: 'Bearer '+clerkKey } })
  if (!jwksRes.ok) throw new Error('JWKS failed')
  const jwks   = await jwksRes.json()
  const jwkKey = jwks.keys?.find(k=>k.kid===header.kid)
  if (!jwkKey) throw new Error('No key')
  const crypto = require('crypto')
  const keyObj = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
  const valid  = crypto.verify('sha256',
    Buffer.from(parts[0]+'.'+parts[1]),
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
    b64d(parts[2]))
  if (!valid) throw new Error('Invalid signature')
  return payload
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const token = (req.headers.authorization||'').replace('Bearer ','').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await verifyClerkJWT(token)
    clerkUserId   = payload.sub
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed: '+e.message })
  }

  // ── Admin always gets active status ───────────────────────────────────────
  if (ADMIN_IDS.includes(clerkUserId)) {
    return res.status(200).json({
      status:  'active',
      plan:    'admin',
      isAdmin: true,
    })
  }

  // ── Regular user — check Supabase ─────────────────────────────────────────
  const supaUrl = process.env.SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    // No DB configured — grant access (dev mode)
    return res.status(200).json({ status: 'active', plan: 'pro' })
  }

  const supabase = createClient(supaUrl, supaKey)
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end, stripe_subscription_id, stripe_customer_id')
    .eq('clerk_id', clerkUserId)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  if (!data)  return res.status(200).json({ status: 'inactive', plan: null })

  let status = data.status

  // Check Stripe directly if pending (race condition fix)
  if ((status === 'pending' || status === 'inactive') && data.stripe_customer_id) {
    try {
      const Stripe = require('stripe')
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
      const subs   = await stripe.subscriptions.list({
        customer: data.stripe_customer_id, limit: 5, status: 'all'
      })
      const active = subs.data.find(s => s.status==='active'||s.status==='trialing')
      if (active) {
        status = active.status
        const periodEnd = new Date(active.current_period_end*1000).toISOString()
        await supabase.from('subscriptions').upsert({
          clerk_id:               clerkUserId,
          stripe_subscription_id: active.id,
          status,
          current_period_end:     periodEnd,
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })
      }
    } catch {}
  }

  // Period expiry check
  const periodEnd = data.current_period_end ? new Date(data.current_period_end) : null
  if ((status==='active'||status==='trialing') && periodEnd && periodEnd < new Date()) {
    status = 'expired'
  }

  return res.status(200).json({
    status,
    plan:              data.plan,
    current_period_end:data.current_period_end,
    subscription_id:   data.stripe_subscription_id,
  })
}
