// api/_lib/auth.js
// Shared auth helper used by all API functions.
// Returns { clerkId, isAdmin, plan, allowed }
//
// FIXES applied:
// 1. Issuer (`iss`) claim is now validated against your actual Clerk
//    instance — previously any correctly-signed JWT from ANY Clerk
//    instance anywhere would pass, not just yours. This matters because
//    signature verification alone only proves "Clerk signed this token
//    for some app" — iss proves it was signed for *this* app.
// 2. `azp` (authorized party) is checked as a soft signal — logged if it
//    doesn't match your production origin, but not hard-rejected, since
//    Clerk doesn't guarantee azp is present in every valid token shape.
// 3. JWKS is now cached in-memory for 10 minutes instead of being fetched
//    fresh from Clerk on every single authenticated request — this was an
//    unnecessary external network round-trip (and a hard dependency on
//    Clerk's JWKS endpoint being up/fast) on every API call.

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

// FIX: your actual Clerk instance issuer — confirmed directly from a decoded
// production JWT (not the dashboard label, which showed the underlying
// .accounts.dev instance domain rather than the custom domain actually
// stamped into live tokens).
const CLERK_ISSUER = process.env.CLERK_ISSUER || 'https://clerk.optionsedgeflow.com'

// FIX: expected production origin, for the soft azp check. Confirmed from a
// live token that azp is the www subdomain.
const EXPECTED_AZP = process.env.PUBLIC_APP_ORIGIN || 'https://www.optionsedgeflow.com'

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad  = b64.length % 4 ? '='.repeat(4 - b64.length % 4) : ''
  return Buffer.from(b64 + pad, 'base64')
}

// FIX: in-memory JWKS cache — module-scope, survives across warm invocations
// on the same Vercel function instance. 10 minute TTL balances "pick up key
// rotation reasonably fast" against "don't hit Clerk on every request."
let _jwksCache = { keys: null, fetchedAt: 0 }
const JWKS_TTL_MS = 10 * 60 * 1000

async function getJWKS(clerkKey) {
  const now = Date.now()
  if (_jwksCache.keys && (now - _jwksCache.fetchedAt) < JWKS_TTL_MS) {
    return _jwksCache.keys
  }
  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: 'Bearer ' + clerkKey }
  })
  if (!jwksRes.ok) {
    // Serve stale cache rather than fail outright, if we have one — better
    // to keep auth working through a transient Clerk hiccup than hard-fail
    // every request in the building.
    if (_jwksCache.keys) return _jwksCache.keys
    throw new Error('JWKS fetch failed: ' + jwksRes.status)
  }
  const jwks = await jwksRes.json()
  _jwksCache = { keys: jwks, fetchedAt: now }
  return jwks
}

async function verifyClerkJWT(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const header  = JSON.parse(base64urlDecode(parts[0]).toString('utf8'))
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'))
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('Token expired')

  // FIX: reject tokens not issued by our own Clerk instance. Signature
  // verification alone doesn't prove this — a validly-signed token from a
  // different Clerk application would otherwise also pass.
  if (payload.iss !== CLERK_ISSUER) {
    throw new Error('Invalid issuer')
  }

  // FIX: soft check only — log a mismatch instead of rejecting, since not
  // every valid Clerk token is guaranteed to carry azp (e.g. some non-browser
  // contexts). This gives visibility without risking a false-positive lockout.
  if (payload.azp && payload.azp !== EXPECTED_AZP) {
    console.warn('[auth] unexpected azp on otherwise-valid token:', payload.azp)
  }

  const clerkKey = process.env.CLERK_SECRET_KEY
  if (!clerkKey) throw new Error('CLERK_SECRET_KEY not set')
  const jwks    = await getJWKS(clerkKey)
  const jwkKey  = jwks.keys?.find(k => k.kid === header.kid)
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
