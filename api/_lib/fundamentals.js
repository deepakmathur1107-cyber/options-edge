// api/_lib/fundamentals.js
// Fetches ticker fundamentals (earnings date, market cap, sector, P/E) from api-ninjas.
// Two-layer cache:
//   1. Upstash Redis — 1-hour TTL (avoids hitting Supabase on every scan tick)
//   2. Supabase ticker_fundamentals table — 7-day TTL (persists across restarts/deployments)
// api-ninjas is only called when Supabase row is missing or stale (> 7 days).
// At ~100 unique tickers in rotation: worst case ~400 api-ninjas calls/month vs 3000 limit.
// CommonJS only — lives in _lib, does NOT count as a Vercel function.

// @supabase/supabase-js is required lazily inside functions (not at module level)
// This prevents a require() failure from crashing the parent tradier.js module

const NINJAS_KEY    = process.env.API_NINJAS_KEY    || ''
const FINNHUB_KEY   = process.env.FINNHUB_API_KEY   || ''  // reuses existing key from newsData.js
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN || ''
const SUPABASE_URL  = process.env.SUPABASE_URL              || ''
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const REDIS_TTL_SECS  = 6 * 60 * 60    // 6 hours; financial statements do not change intraday
const SUPABASE_TTL_MS = 7 * 24 * 3600 * 1000  // 7 days in Supabase

// ── Supabase client (lazy singleton) ─────────────────────────────────────────
// Required lazily to avoid crashing tradier.js if the module fails to load
let _sb = null
function sb() {
  if (!_sb && SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(SUPABASE_URL, SUPABASE_KEY)
    } catch (e) {
      console.warn('[fundamentals] supabase require failed:', e.message)
      return null
    }
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

// ── api-ninjas usage counter ──────────────────────────────────────────────────
// Tracks real api-ninjas calls (not cache hits) so usage can be watched against
// the 3000/month free-tier cap. Two keys: a daily counter (30-day TTL, gives a
// per-day trend) and a running monthly counter keyed by calendar month (reset
// is manual — see ADMIN tab) since api-ninjas' own reset date isn't exposed to us.
async function incrNinjasUsage() {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    const today = new Date().toISOString().slice(0, 10)        // YYYY-MM-DD
    const month = today.slice(0, 7)                            // YYYY-MM
    const dayKey   = `ninjas_usage:day:${today}`
    const monthKey = `ninjas_usage:month:${month}`
    await Promise.all([
      fetch(`${REDIS_URL}/incr/${encodeURIComponent(dayKey)}`,   { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }),
      fetch(`${REDIS_URL}/incr/${encodeURIComponent(monthKey)}`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }),
      fetch(`${REDIS_URL}/expire/${encodeURIComponent(dayKey)}`,   { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify([30*24*3600]) }),
      fetch(`${REDIS_URL}/expire/${encodeURIComponent(monthKey)}`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify([62*24*3600]) }),
    ])
  } catch (e) { console.warn('[fundamentals] usage counter failed:', e.message) }
}

// ── Read usage stats (for admin dashboard) ────────────────────────────────────
async function getNinjasUsage() {
  if (!REDIS_URL || !REDIS_TOKEN) return { today: 0, month: 0, last7Days: [] }
  try {
    const today = new Date()
    const monthKey = today.toISOString().slice(0, 7)
    const dayKeys = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 24 * 3600 * 1000)
      dayKeys.push(d.toISOString().slice(0, 10))
    }
    const fetchCount = async (key) => {
      try {
        const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } })
        const d = await r.json()
        return parseInt(d?.result || '0', 10) || 0
      } catch { return 0 }
    }
    const [monthTotal, ...dayTotals] = await Promise.all([
      fetchCount(`ninjas_usage:month:${monthKey}`),
      ...dayKeys.map(d => fetchCount(`ninjas_usage:day:${d}`)),
    ])
    return {
      today: dayTotals[0] || 0,
      month: monthTotal,
      last7Days: dayKeys.map((d, i) => ({ date: d, count: dayTotals[i] || 0 })),
    }
  } catch { return { today: 0, month: 0, last7Days: [] } }
}

// ── Finnhub earnings fetch (free tier) ───────────────────────────────────────
async function fetchEarningsFromFinnhub(ticker) {
  if (!FINNHUB_KEY) return null
  try {
    const from = new Date().toISOString().slice(0, 10)
    const to   = new Date(Date.now() + 90*24*3600*1000).toISOString().slice(0, 10)
    const url  = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${FINNHUB_KEY}`
    const res  = await fetch(url)
    if (!res.ok) return null
    const data   = await res.json()
    const events = (data?.earningsCalendar || [])
      .filter(e => e.date >= from)
      .sort((a, b) => a.date.localeCompare(b.date))
    return events[0]?.date || null  // YYYY-MM-DD or null
  } catch (e) {
    console.warn(`[fundamentals] Finnhub error for ${ticker}:`, e.message)
    return null
  }
}

// Finnhub basic financials supplies the health metrics that the stock gate
// needs. This is kept server-side and cached with the combined fundamentals
// object, so the API key never reaches the browser.
async function fetchFinancialMetricsFromFinnhub(ticker) {
  if (!FINNHUB_KEY) return {}
  try {
    const url=`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`
    const res=await fetch(url)
    if (!res.ok) return {}
    const metric=(await res.json())?.metric||{}
    const number=(...keys)=>{
      for (const key of keys) {
        const value=metric[key]
        if (value!==null&&value!==''&&Number.isFinite(Number(value))) return Number(value)
      }
      return null
    }
    const marketCapMillions=number('marketCapitalization')
    return {
      market_cap:marketCapMillions==null?null:marketCapMillions*1_000_000,
      pe_ratio:number('peBasicExclExtraTTM','peTTM','peNormalizedAnnual'),
      net_profit_margin_ttm:number('netProfitMarginTTM'),
      revenue_growth_ttm_yoy:number('revenueGrowthTTMYoy'),
      eps_growth_ttm_yoy:number('epsGrowthTTMYoy'),
      debt_to_equity_annual:number('totalDebt/totalEquityAnnual','totalDebtToEquityAnnual'),
      current_ratio_annual:number('currentRatioAnnual'),
      roe_ttm:number('roeTTM','roeRfy'),
      free_cash_flow_ttm:number('freeCashFlowPerShareTTM','freeCashFlowTTM'),
      health_metrics_source:'Finnhub basic financials',
      health_metrics_updated_at:new Date().toISOString(),
    }
  } catch (e) {
    console.warn(`[fundamentals] Finnhub metrics error for ${ticker}:`,e.message)
    return {}
  }
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
    await incrNinjasUsage()   // count the real hit regardless of outcome below
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

    // ── 3. Finnhub — upcoming earnings date (free, reuses existing key) ─────
    const earnings_date = await fetchEarningsFromFinnhub(ticker)

    return {
      ticker:        tickerData.ticker || ticker,
      market_cap,
      pe_ratio:      null,
      sector,
      industry,
      earnings_date,   // YYYY-MM-DD from Finnhub, or null
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
  if (cached) {
    if (cached.health_metrics_updated_at) return cached
    const metrics=await fetchFinancialMetricsFromFinnhub(ticker)
    const combined={...cached,...metrics,market_cap:metrics.market_cap??cached.market_cap,pe_ratio:metrics.pe_ratio??cached.pe_ratio}
    await redisSet(redisKey,combined,REDIS_TTL_SECS)
    return combined
  }

  // 2. Supabase (fast — ~50ms, persisted across deployments)
  const stored = await supabaseGet(ticker)
  if (stored) {
    const metrics=await fetchFinancialMetricsFromFinnhub(ticker)
    const combined={...stored,...metrics,market_cap:metrics.market_cap??stored.market_cap,pe_ratio:metrics.pe_ratio??stored.pe_ratio}
    await redisSet(redisKey, combined, REDIS_TTL_SECS)
    return combined
  }

  // 3. api-ninjas (external call — counts against 3000/month limit)
  console.log(`[fundamentals] cache miss — calling api-ninjas for ${ticker}`)
  const fresh = await fetchFromNinjas(ticker)
  if (fresh) {
    const metrics=await fetchFinancialMetricsFromFinnhub(ticker)
    const combined={...fresh,...metrics,market_cap:metrics.market_cap??fresh.market_cap,pe_ratio:metrics.pe_ratio??fresh.pe_ratio}
    // Persist to both layers
    await supabaseSet(fresh)
    await redisSet(redisKey, combined, REDIS_TTL_SECS)
    return combined
  }
  return fresh  // may be null if providers returned nothing
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

module.exports = { getFundamentals, prefetchFundamentals, getNinjasUsage }
