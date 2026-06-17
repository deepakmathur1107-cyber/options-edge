// api/_lib/fundamentals.js
// Fetches ticker fundamentals (earnings date, market cap, sector, P/E) from api-ninjas.
// Two-layer cache:
//   1. Upstash Redis — 1-hour TTL (avoids hitting Supabase on every scan tick)
//   2. Supabase ticker_fundamentals table — 7-day TTL (persists across restarts/deployments)
// api-ninjas is only called when Supabase row is missing or stale (> 7 days).
// At ~100 unique tickers in rotation: worst case ~400 api-ninjas calls/month vs 3000 limit.
// CommonJS only — lives in _lib, does NOT count as a Vercel function.

const { createClient } = require('@supabase/supabase-js')

const NINJAS_KEY    = process.env.API_NINJAS_KEY    || ''
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN || ''
const SUPABASE_URL  = process.env.SUPABASE_URL              || ''
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const REDIS_TTL_SECS  = 60 * 60        // 1 hour in Redis
const SUPABASE_TTL_MS = 7 * 24 * 3600 * 1000  // 7 days in Supabase

// ── Supabase client (lazy singleton) ─────────────────────────────────────────
let _sb = null
function sb() {
  if (!_sb && SUPABASE_URL && SUPABASE_KEY) {
    _sb = createClient(SUPABASE_URL, SUPABASE_KEY)
  }
  return _sb
}

// ── Redis helpers (same pattern as tradier.js) ────────────────────────────────
async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    })
    const d = await r.json()
    if (!d.result) return null
    const parsed = typeof d.result === 'string' ? JSON.parse(d.result) : d.result
    // Unwrap Upstash {value, ex} wrapper if present
    if (parsed && typeof parsed === 'object' && 'value' in parsed && 'ex' in parsed) {
      return typeof parsed.value === 'string' ? JSON.parse(parsed.value) : parsed.value
    }
    return parsed
  } catch { return null }
}

async function redisSet(key, value, ttl) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttl]]),
    })
  } catch {}
}

// ── api-ninjas fetch ──────────────────────────────────────────────────────────
// Free tier available endpoints (verified):
//   /v1/ticker  → company name, exchange (market_cap is premium-only)
//   /v1/sp500   → sector, sub_industry (SP500 constituents only)
//   /v1/upcomingearnings → PREMIUM ONLY (400 on free tier)
//
// Each call = 1 hit against 3000/month limit.
// Total: 2 hits per new ticker, 0 after Supabase caches for 7 days.
//
// Earnings date strategy: inferred from Tradier IV term-structure in App.jsx
// (significant IV spike on a specific expiry = earnings likely in that window).
// We store a placeholder null here; the scanner reads it as "unknown" gracefully.
async function fetchFromNinjas(ticker) {
  if (!NINJAS_KEY) return null
  const H = { 'X-Api-Key': NINJAS_KEY }

  try {
    // ── 1. /v1/ticker — company profile ──────────────────────────────────
    const tickerRes = await fetch(
      `https://api.api-ninjas.com/v1/ticker?ticker=${encodeURIComponent(ticker)}`,
      { headers: H }
    )
    if (!tickerRes.ok) {
      console.warn(`[fundamentals] /v1/ticker ${tickerRes.status} for ${ticker}`)
      return null
    }
    const tickerData = await tickerRes.json()
    if (!tickerData || !tickerData.ticker) return null
    console.log(`[fundamentals] /v1/ticker OK for ${ticker}: exchange=${tickerData.exchange}`)

    // ── 2. /v1/sp500 — sector + sub-industry (SP500 stocks only) ─────────
    // Non-SP500 stocks return empty array — that's fine, sector stays null
    let sector = null, industry = null
    try {
      const spRes = await fetch(
        `https://api.api-ninjas.com/v1/sp500?ticker=${encodeURIComponent(ticker)}`,
        { headers: H }
      )
      if (spRes.ok) {
        const spData = await spRes.json()
        if (Array.isArray(spData) && spData.length > 0) {
          sector   = spData[0].sector       || null  // e.g. "Information Technology"
          industry = spData[0].sub_industry || null  // e.g. "Semiconductors"
          console.log(`[fundamentals] /v1/sp500 OK for ${ticker}: ${sector} / ${industry}`)
        }
      }
    } catch (e) {
      console.warn(`[fundamentals] sp500 error for ${ticker}:`, e.message)
    }

    // market_cap: free tier returns a premium-only string — treat as null
    const rawMcap = tickerData.latest_market_cap
    const market_cap = (typeof rawMcap === 'number') ? rawMcap : null

    return {
      ticker:        tickerData.ticker || ticker,
      market_cap,                          // null on free tier
      pe_ratio:      null,                 // not available on free tier
      sector,                              // from sp500 endpoint, null for non-SP500
      industry,
      earnings_date: null,                 // premium-only; inferred via IV term-structure
      updated_at:    new Date().toISOString(),
    }
  } catch (e) {
    console.warn(`[fundamentals] fetchFromNinjas error for ${ticker}:`, e.message)
    return null
  }
}

// ── Supabase read ─────────────────────────────────────────────────────────────
async function supabaseGet(ticker) {
  const client = sb()
  if (!client) return null
  try {
    const { data, error } = await client
      .from('ticker_fundamentals')
      .select('*')
      .eq('ticker', ticker)
      .maybeSingle()
    if (error || !data) return null
    // Check freshness
    const age = Date.now() - new Date(data.updated_at).getTime()
    if (age > SUPABASE_TTL_MS) return null  // stale — will re-fetch from ninjas
    return data
  } catch { return null }
}

// ── Supabase write (upsert) ───────────────────────────────────────────────────
async function supabaseSet(row) {
  const client = sb()
  if (!client) return
  try {
    await client
      .from('ticker_fundamentals')
      .upsert(row, { onConflict: 'ticker' })
  } catch (e) {
    console.warn('[fundamentals] supabase upsert error:', e.message)
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
// Returns fundamentals object or null (never throws).
// Caller should handle null gracefully (scoring just skips fundamentals bonus).
async function getFundamentals(ticker) {
  const redisKey = `fund:${ticker}`

  // 1. Redis (fastest — sub-ms)
  const cached = await redisGet(redisKey)
  if (cached) return cached

  // 2. Supabase (fast — ~50ms, persisted across deployments)
  const stored = await supabaseGet(ticker)
  if (stored) {
    await redisSet(redisKey, stored, REDIS_TTL_SECS)  // warm Redis
    return stored
  }

  // 3. api-ninjas (external call — counts against 3000/month limit)
  console.log(`[fundamentals] cache miss — calling api-ninjas for ${ticker}`)
  const fresh = await fetchFromNinjas(ticker)
  if (fresh) {
    // Persist to both layers
    await supabaseSet(fresh)
    await redisSet(redisKey, fresh, REDIS_TTL_SECS)
  }
  return fresh  // may be null if ninjas returned nothing
}

// ── Bulk prefetch (call once for watchlist at scan start) ─────────────────────
// Fetches tickers not already in Supabase, respecting a per-call cap so we
// never accidentally dump 500 api-ninjas calls in one run.
async function prefetchFundamentals(tickers, maxNinjasCalls = 20) {
  let ninjasCalled = 0
  for (const ticker of tickers) {
    if (ninjasCalled >= maxNinjasCalls) break
    const redisKey = `fund:${ticker}`
    const cached = await redisGet(redisKey)
    if (cached) continue
    const stored = await supabaseGet(ticker)
    if (stored) { await redisSet(redisKey, stored, REDIS_TTL_SECS); continue }
    // Not cached anywhere — call ninjas
    const fresh = await fetchFromNinjas(ticker)
    ninjasCalled++
    if (fresh) {
      await supabaseSet(fresh)
      await redisSet(redisKey, fresh, REDIS_TTL_SECS)
    }
    // Small delay to avoid rate-limiting
    await new Promise(r => setTimeout(r, 200))
  }
  console.log(`[fundamentals] prefetch done — ${ninjasCalled} api-ninjas calls`)
}

module.exports = { getFundamentals, prefetchFundamentals }
