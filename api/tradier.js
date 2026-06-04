// api/tradier.js — Phase 2
// Admin Tradier key + Redis cache + usage gate.
// Fully defensive: works even if Redis/Supabase are not configured.

const TRADIER_BASE  = process.env.TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN

// ─── Redis (optional — skipped if not configured) ─────────────────────────────
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
  if (!REDIS_URL || !REDIS_TOKEN) return 0
  try {
    const res  = await fetch(`${REDIS_URL}/incr/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    })
    const data = await res.json()
    return data.result || 0
  } catch { return 0 }
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

// ─── Supabase (optional — skipped if not configured) ─────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  try {
    const { createClient } = require('@supabase/supabase-js')
    return createClient(url, key)
  } catch { return null }
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
  const clerkKey = process.env.CLERK_SECRET_KEY
  if (!clerkKey) throw new Error('CLERK_SECRET_KEY not set')
  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: 'Bearer ' + clerkKey }
  })
  if (!jwksRes.ok) throw new Error('JWKS fetch failed: ' + jwksRes.status)
  const jwks   = await jwksRes.json()
  const jwkKey = jwks.keys?.find(k => k.kid === header.kid)
  if (!jwkKey) throw new Error('No matching JWKS key for kid: ' + header.kid)
  const crypto = require('crypto')
  const keyObj = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
  const valid  = crypto.verify('sha256',
    Buffer.from(parts[0] + '.' + parts[1]),
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(parts[2]))
  if (!valid) throw new Error('Invalid signature')
  return payload
}

// ─── Subscription check (optional) ──────────────────────────────────────────
async function getSubPlan(clerkId) {
  const supabase = getSupabase()
  if (!supabase) return 'pro' // no DB = assume pro (development mode)
  try {
    const cacheKey = `sub:${clerkId}`
    const cached   = await redisGet(cacheKey)
    if (cached) return cached.plan || 'free'
    const { data } = await supabase
      .from('subscriptions')
      .select('status, plan')
      .eq('clerk_id', clerkId)
      .maybeSingle()
    const status = data?.status || 'inactive'
    const plan   = (status === 'active' || status === 'trialing') ? (data?.plan || 'pro') : 'free'
    await redisSet(cacheKey, { status, plan }, 300)
    return plan
  } catch { return 'free' }
}

// ─── Usage gate (free = 4 scans/day) ─────────────────────────────────────────
const FREE_LIMIT = 4

async function checkUsage(clerkId, plan) {
  if (plan !== 'free') return { allowed: true }
  const today    = new Date().toISOString().split('T')[0]
  const usageKey = `usage:${clerkId}:${today}`
  const count    = await redisIncr(usageKey)
  if (count === 1) await redisExpire(usageKey, 90000)
  if (count > FREE_LIMIT) return { allowed: false, count, limit: FREE_LIMIT }
  return { allowed: true, count, limit: FREE_LIMIT }
}

// ─── TTL by path ──────────────────────────────────────────────────────────────
function getTTL(path) {
  if (path.includes('expirations')) return 86400
  if (path.includes('chains'))      return 300
  if (path.includes('quotes'))      return 30
  return 30
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tradier-token, x-tradier-mode')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const tradierPath = req.query.path
  if (!tradierPath) return res.status(400).json({ error: 'Missing ?path= param' })

  // ── Resolve which Tradier token to use ────────────────────────────────────
  let activeToken = TRADIER_TOKEN  // admin key is default
  const clerkJWT  = (req.headers.authorization || '').replace('Bearer ', '').trim()
  const legacyTok = req.headers['x-tradier-token']

  if (clerkJWT) {
    try {
      const payload  = await verifyClerkJWT(clerkJWT)
      const clerkId  = payload.sub
      const plan     = await getSubPlan(clerkId)
      const usage    = await checkUsage(clerkId, plan)
      if (!usage.allowed) {
        return res.status(429).json({
          error:   `Free tier limit: ${usage.limit} scans/day. Upgrade for unlimited.`,
          upgrade: true,
          count:   usage.count,
          limit:   usage.limit,
        })
      }
    } catch (e) {
      // JWT failed — still serve using admin key
      console.log('JWT verify skipped:', e.message)
    }
  } else if (legacyTok) {
    activeToken = legacyTok
  }

  if (!activeToken) {
    return res.status(401).json({
      error: 'TRADIER_TOKEN not set. Add it in Vercel → Settings → Environment Variables.'
    })
  }

  // ── Redis cache check ─────────────────────────────────────────────────────
  const qs  = new URLSearchParams(req.query)
  qs.delete('path')
  const qsStr    = qs.toString()
  const fullPath = tradierPath + (qsStr ? '&' + qsStr : '')
  const cKey     = 'tr:' + fullPath.replace(/[^a-zA-Z0-9._%-]/g, '_').slice(0, 200)
  const ttl      = getTTL(tradierPath)

  const cached = await redisGet(cKey)
  if (cached) {
    res.setHeader('X-Cache', 'HIT')
    return res.status(200).json(cached)
  }

  // ── Call Tradier ──────────────────────────────────────────────────────────
  const url = `${TRADIER_BASE}${tradierPath}${qsStr ? '?' + qsStr : ''}`
  console.log('Tradier fetch:', url.replace(activeToken, '***'))

  try {
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${activeToken}`,
        Accept:        'application/json',
      }
    })

    const text = await upstream.text()
    let data
    try   { data = JSON.parse(text) }
    catch { return res.status(upstream.status).json({ error: 'Non-JSON response', raw: text.slice(0, 200) }) }

    if (upstream.ok) {
      await redisSet(cKey, data, ttl)
      res.setHeader('X-Cache', 'MISS')
    } else {
      console.error('Tradier error:', upstream.status, text.slice(0, 200))
    }

    return res.status(upstream.status).json(data)

  } catch (e) {
    console.error('Tradier fetch error:', e.message)
    return res.status(500).json({ error: 'Tradier fetch failed: ' + e.message })
  }
}
