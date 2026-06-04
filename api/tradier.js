// api/tradier.js
// Minimal admin-key proxy — no Supabase, no Clerk, no Redis required.
// Add those back once basic data flow is confirmed working.

const TRADIER_MODE  = process.env.TRADIER_MODE  || 'production'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN  || ''
const TRADIER_BASE  = TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'

// Optional Redis cache — skipped if not configured
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

async function cacheGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } })
    const d = await r.json()
    return d.result ? JSON.parse(d.result) : null
  } catch { return null }
}

async function cacheSet(key, value, ttl) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: JSON.stringify(value), ex: ttl })
    })
  } catch {}
}

function getTTL(path) {
  if (path.includes('expirations')) return 86400  // 24h
  if (path.includes('chains'))      return 300    // 5min
  return 30                                       // 30s for quotes
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tradier-token, x-tradier-mode')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const tradierPath = req.query.path
  if (!tradierPath) return res.status(400).json({ error: 'Missing ?path= param' })

  // Determine which token to use
  // 1. Legacy per-user token from header (backwards compat)
  // 2. Admin token from env (Phase 2 default)
  const legacyToken = req.headers['x-tradier-token'] || ''
  const activeToken = legacyToken || TRADIER_TOKEN

  if (!activeToken) {
    return res.status(401).json({
      error: 'No Tradier token. Set TRADIER_TOKEN in Vercel Environment Variables.',
      mode:  TRADIER_MODE,
      base:  TRADIER_BASE,
    })
  }

  // Build query string (extra params beyond ?path=)
  const qs = new URLSearchParams(req.query)
  qs.delete('path')
  const qsStr = qs.toString()

  // Cache key
  const cacheKey = ('tr:' + tradierPath + (qsStr ? '?' + qsStr : ''))
    .replace(/[^\w:._%-]/g, '_')
    .slice(0, 200)

  // Check cache
  const cached = await cacheGet(cacheKey)
  if (cached) {
    res.setHeader('X-Cache', 'HIT')
    return res.status(200).json(cached)
  }

  // Call Tradier
  const url = `${TRADIER_BASE}${tradierPath}${qsStr ? '?' + qsStr : ''}`
  console.log(`[tradier] ${TRADIER_MODE} → ${url}`)

  try {
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${activeToken}`,
        Accept:        'application/json',
      }
    })

    const text = await upstream.text()

    let data
    try {
      data = JSON.parse(text)
    } catch {
      console.error('[tradier] Non-JSON:', text.slice(0, 300))
      return res.status(502).json({ error: 'Non-JSON from Tradier', raw: text.slice(0, 200) })
    }

    if (upstream.ok) {
      await cacheSet(cacheKey, data, getTTL(tradierPath))
      res.setHeader('X-Cache', 'MISS')
    } else {
      console.error(`[tradier] ${upstream.status}:`, JSON.stringify(data).slice(0, 200))
    }

    return res.status(upstream.status).json(data)

  } catch (e) {
    console.error('[tradier] fetch error:', e.message)
    return res.status(500).json({ error: 'Tradier fetch failed: ' + e.message })
  }
}
