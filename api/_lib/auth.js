// api/middleware/auth.js
// Shared auth helper used by all API functions.
// Returns { clerkId, isAdmin, plan, allowed }

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

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
  const clerkKey = process.env.CLERK_SECRET_KEY
  if (!clerkKey) throw new Error('CLERK_SECRET_KEY not set')
  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: 'Bearer ' + clerkKey }
  })
  if (!jwksRes.ok) throw new Error('JWKS fetch failed: ' + jwksRes.status)
  const jwks   = await jwksRes.json()
  const jwkKey = jwks.keys?.find(k => k.kid === header.kid)
  if (!jwkKey) throw new Error('No matching JWKS key')
  const crypto = require('crypto')
  const keyObj = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
  const valid  = crypto.verify('sha256',
    Buffer.from(parts[0] + '.' + parts[1]),
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(parts[2]))
  if (!valid) throw new Error('Invalid signature')
  return payload
}

async function getSubPlan(clerkId) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return 'pro'  // no DB = assume pro (dev mode)
  try {
    const { createClient } = require('@supabase/supabase-js')
    const supabase = createClient(url, key)
    const { data } = await supabase
      .from('subscriptions')
      .select('status, plan')
      .eq('clerk_id', clerkId)
      .maybeSingle()
    const status = data?.status || 'inactive'
    if (status === 'active' || status === 'trialing') return data?.plan || 'pro'
    return 'free'
  } catch { return 'free' }
}

// Main auth function — call this at the top of every handler
async function getAuth(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()

  if (!token) {
    return { clerkId: null, isAdmin: false, plan: 'free', allowed: false, error: 'No token' }
  }

  try {
    const payload = await verifyClerkJWT(token)
    const clerkId = payload.sub
    const isAdmin = ADMIN_IDS.includes(clerkId)

    // Admins always get full access — no subscription check
    if (isAdmin) {
      return { clerkId, isAdmin: true, plan: 'admin', allowed: true }
    }

    const plan    = await getSubPlan(clerkId)
    const allowed = plan === 'pro' || plan === 'core'

    return { clerkId, isAdmin: false, plan, allowed }

  } catch (e) {
    return { clerkId: null, isAdmin: false, plan: 'free', allowed: false, error: e.message }
  }
}

module.exports = { getAuth, ADMIN_IDS }
