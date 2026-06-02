// api/tradier.js — Phase 2
// Admin Tradier key (no per-user token needed).
// Redis cache: quotes 30s, chains 5min, expiries 24h.
// Usage gate: free users capped at 4 scans/day.

const TRADIER_BASE = process.env.TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'

const TRADIER_TOKEN = process.env.TRADIER_TOKEN

// ─── Redis helpers (Upstash REST API) ────────────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const res  = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    })
    const data = await res.json()
    return data.result ? JSON.parse(data.result) : null
  } catch { return null }
}

async function redisSet(key, value, ttlSeconds) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: JSON.stringify(value), ex: ttlSeconds })
    })
  } catch {}
}

async function redisIncr(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return 999
  try {
    const res  = await fetch(`${REDIS_URL}/incr/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    })
    const data = await res.json()
    return data.result || 999
  } catch { return 999 }
}

async function redisExpire(key, ttlSeconds) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    await fetch(`${REDIS_URL}/expire/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key, seconds: ttlSeconds })
    })
  } catch {}
}

// ─── Cache TTLs ───────────────────────────────────────────────────────────────
const TTL = {
  quote:    30,        // 30 seconds — fast enough for trading
  chain:    300,       // 5 minutes — heavy call
  expiries: 86400,     // 24 hours — never changes intraday
  spxBar:   15,        // 15 seconds — price bar in header
}

function cacheKey(path, qs) {
  const base = path.replace(/\//g, ':').replace(/^:/, '')
  const sym  = qs.get('symbols') || qs.get('symbol') || ''
  const exp  = qs.get('expiration') || ''
  return `tradier:${base}:${sym}:${exp}`.replace(/::+/g, ':').replace(/:$/,'')
}

function ttlForPath(path) {
  if (path.includes('quotes'))      return TTL.quote
  if (path.includes('chains'))      return TTL.chain
  if (path.includes('expirations')) return TTL.expiries
  return TTL.quote
}

// ─── Clerk JWT verification ───────────────────────────────────────────────────
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

// ─── Subscription lookup from Redis cache ─────────────────────────────────────
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function getSubStatus(clerkId) {
  // Check Redis first (5 min cache)
  const cacheKey_ = `sub:${clerkId}`
  const cached    = await redisGet(cacheKey_)
  if (cached) return cached

  const { data } = await supabase
    .from('subscriptions')
    .select('status, plan')
    .eq('clerk_id', clerkId)
    .maybeSingle()

  const status = data?.status || 'inactive'
  const plan   = data?.plan   || 'free'
  await redisSet(cacheKey_, { status, plan }, 300)
  return { status, plan }
}

// ─── Usage gate for free users ────────────────────────────────────────────────
const FREE_DAILY_LIMIT = 4

async function checkUsage(clerkId, plan) {
  // Pro/active users have no limit
  if (plan === 'pro' || plan === 'core') return { allowed: true }

  const today   = new Date().toISOString().split('T')[0]   // YYYY-MM-DD
  const usageKey = `usage:${clerkId}:${today}`

  const count = await redisIncr(usageKey)
  // Set expiry on first increment (25 hours — covers midnight rollover)
  if (count === 1) await redisExpire(usageKey, 90000)

  if (count > FREE_DAILY_LIMIT) {
    return {
      allowed:   false,
      count,
      limit:     FREE_DAILY_LIMIT,
      resetTime: 'midnight UTC',
    }
  }
  return { allowed: true, count, limit: FREE_DAILY_LIMIT }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tradier-token, x-tradier-mode')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const tradierPath = req.query.path
  if (!tradierPath) return res.status(400).json({ error: 'Missing ?path= param' })

  // ── Auth + subscription check ──────────────────────────────────────────────
  // Accept either Clerk JWT (new) or legacy x-tradier-token header (backwards compat)
  const authHeader    = req.headers.authorization || ''
  const legacyToken   = req.headers['x-tradier-token']
  const clerkJWT      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  let tradierToken = TRADIER_TOKEN   // default: admin token
  let isFreePlan   = false
  let clerkUserId  = null

  if (clerkJWT && TRADIER_TOKEN) {
    // Phase 2 path: verify Clerk JWT, check subscription, apply usage gate
    try {
      const payload = await verifyClerkJWT(clerkJWT)
      clerkUserId   = payload.sub

      const { status, plan } = await getSubStatus(clerkUserId)
      const isPaid = status === 'active' || status === 'trialing'
      isFreePlan   = !isPaid

      // Usage gate for free users
      const usage = await checkUsage(clerkUserId, isPaid ? plan : 'free')
      if (!usage.allowed) {
        return res.status(429).json({
          error:    `Free tier limit reached (${usage.limit} scans/day). Upgrade to Pro for unlimited scans.`,
          count:    usage.count,
          limit:    usage.limit,
          upgrade:  true,
        })
      }
    } catch (e) {
      // JWT verify failed — fall through to admin token (dev/testing mode)
      console.log('Auth fallback (JWT error):', e.message)
    }
  } else if (legacyToken) {
    // Legacy path: user-provided token (Phase 1 backwards compat)
    tradierToken = legacyToken
  } else if (!TRADIER_TOKEN) {
    return res.status(401).json({ error: 'No Tradier token configured. Add TRADIER_TOKEN to Vercel env vars.' })
  }

  // ── Build cache key ────────────────────────────────────────────────────────
  const params = new URLSearchParams(req.query)
  params.delete('path')
  const qs    = params
  const key   = cacheKey(tradierPath, qs)
  const ttl   = ttlForPath(tradierPath)

  // ── Cache check ────────────────────────────────────────────────────────────
  const cached = await redisGet(key)
  if (cached) {
    res.setHeader('X-Cache', 'HIT')
    return res.status(200).json(cached)
  }

  // ── Call Tradier ───────────────────────────────────────────────────────────
  const qsStr = qs.toString()
  const url   = `${TRADIER_BASE}${tradierPath}${qsStr ? '?' + qsStr : ''}`

  try {
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tradierToken}`,
        Accept:        'application/json',
      }
    })

    const text = await upstream.text()
    let data
    try   { data = JSON.parse(text) }
    catch { data = { raw: text } }

    // Cache successful responses only
    if (upstream.ok) {
      await redisSet(key, data, ttl)
      res.setHeader('X-Cache', 'MISS')
    }

    return res.status(upstream.status).json(data)

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
