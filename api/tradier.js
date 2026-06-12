// api/tradier.js
// Fixed: cache returns correct data shape
// Fixed: no-token requests use server TRADIER_TOKEN directly (no user auth needed for market data)

const TRADIER_MODE  = process.env.TRADIER_MODE  || 'production'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN  || ''
const TRADIER_BASE  = TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''
const FREE_LIMIT  = 4

// ─── Redis helpers ─────────────────────────────────────────────────────────────
async function cacheGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } })
    const d = await r.json()
    // d.result is the raw stored string — parse it to get the actual data object
    if (!d.result) return null
    const parsed = typeof d.result === 'string' ? JSON.parse(d.result) : d.result
    // Guard against accidentally returning the Redis wrapper {value, ex}
    if (parsed && typeof parsed === 'object' && 'value' in parsed && 'ex' in parsed) {
      // This is the raw Upstash SET response — unwrap the value
      return typeof parsed.value === 'string' ? JSON.parse(parsed.value) : parsed.value
    }
    return parsed
  } catch { return null }
}

async function cacheSet(key, value, ttl) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    // Use Upstash REST pipeline SET — POST with JSON body avoids URL length limits
    // for large option chain payloads
    await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttl]]),
    })
  } catch {}
}

async function usageIncr(clerkId) {
  if (!REDIS_URL || !REDIS_TOKEN) return 0
  const today = new Date().toISOString().split('T')[0]
  const key   = `usage:${clerkId}:${today}`
  try {
    const r = await fetch(`${REDIS_URL}/incr/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    })
    const d = await r.json()
    const count = d.result || 0
    if (count === 1) {
      await fetch(`${REDIS_URL}/expire/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, seconds: 90000 })
      })
    }
    return count
  } catch { return 0 }
}

function getTTL(path) {
  if (path.includes('expirations')) return 86400
  if (path.includes('chains'))      return 300
  return 30
}

// ─── Clerk JWT verify ──────────────────────────────────────────────────────────
const { getAuth, ADMIN_IDS: LIB_ADMIN_IDS } = require('./_lib/auth')

async function getPlan(clerkId) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !clerkId) return 'pro'
  try {
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(url, key)
    const { data } = await sb.from('subscriptions')
      .select('status').eq('clerk_id', clerkId).maybeSingle()
    const s = data?.status || 'inactive'
    return (s==='active'||s==='trialing') ? 'pro' : 'free'
  } catch { return 'pro' }
}

// ─── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tradier-token, x-tradier-mode')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const tradierPath = req.query.path
  if (!tradierPath) return res.status(400).json({ error: 'Missing ?path= param' })

  // ── Token resolution ────────────────────────────────────────────────────────
  const legacyToken = req.headers['x-tradier-token'] || ''
  const activeToken = legacyToken || TRADIER_TOKEN
  if (!activeToken) {
    return res.status(500).json({ error: 'No Tradier token configured. Set TRADIER_TOKEN in Vercel env vars.' })
  }

  // ── Admin check ─────────────────────────────────────────────────────────────
  const ADMIN_IDS = LIB_ADMIN_IDS || (process.env.ADMIN_CLERK_IDS||'').split(',').map(s=>s.trim()).filter(Boolean)
  const { clerkId } = await getAuth(req)
  const isAdmin   = clerkId && ADMIN_IDS.includes(clerkId)

  // ── Usage gate (free users only) ─────────────────────────────────────────────
  // If no clerkId at all — still allow, server token covers market data access
  if (clerkId && !isAdmin) {
    const plan = await getPlan(clerkId)
    if (plan === 'free') {
      const count = await usageIncr(clerkId)
      if (count > FREE_LIMIT) {
        return res.status(429).json({
          error:   `Free tier: ${FREE_LIMIT} scans/day. Upgrade for unlimited.`,
          upgrade: true,
          count,
          limit:   FREE_LIMIT,
        })
      }
    }
  }

  // ── Build Tradier URL ───────────────────────────────────────────────────────
  const qs    = new URLSearchParams(req.query)
  qs.delete('path')
  const qsStr = qs.toString()
  const url   = `${TRADIER_BASE}${tradierPath}${qsStr ? '?' + qsStr : ''}`

  // ── Cache check (skip for admin — always fresh) ─────────────────────────────
  const cKey = ('tr:'+TRADIER_MODE+':'+tradierPath+(qsStr?'?'+qsStr:''))
    .replace(/[^\w:._%-]/g,'_').slice(0,200)

  if (!isAdmin) {
    const cached = await cacheGet(cKey)
    if (cached) {
      res.setHeader('X-Cache', 'HIT')
      return res.status(200).json(cached)
    }
  }

  // ── Call Tradier ────────────────────────────────────────────────────────────
  console.log(`[tradier] ${tradierPath}`)

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${activeToken}`, Accept: 'application/json' }
    })

    const text = await upstream.text()
    let data
    try   { data = JSON.parse(text) }
    catch { return res.status(502).json({ error: 'Non-JSON from Tradier', raw: text.slice(0,200) }) }

    if (upstream.ok) {
      if (!isAdmin) await cacheSet(cKey, data, getTTL(tradierPath))
      res.setHeader('X-Cache', 'MISS')
    } else {
      console.error(`[tradier] ${upstream.status}:`, JSON.stringify(data).slice(0,200))
    }

    return res.status(upstream.status).json(data)

  } catch (e) {
    console.error('[tradier] error:', e.message)
    return res.status(500).json({ error: 'Tradier fetch failed: ' + e.message })
  }
}
