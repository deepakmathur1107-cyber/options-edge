// api/cron/scan.js
//
// Server-side replacement for the browser-only auto-scanner loop. Triggered by
// Vercel Cron (see vercel.json) every 15 minutes. Each invocation scans ONE
// timeframe across the watchlist (rotated — see SCHEDULE below) so a single
// run comfortably fits inside the Pro tier's maxDuration, and writes every
// result into Supabase scan_results so the frontend can read instantly
// instead of re-scanning live.
//
// Schedule (set in vercel.json):
//   Quick Play  + Swing Trade  → every 15 min (fast-moving setups)
//   LEAP        + Deep LEAP    → every 60 min (slow-moving, don't need 15-min refresh)
//
// This file orchestrates; api/_lib/scanLogic.js holds the actual scoring math
// (ported from src/App.jsx's scanOneTicker so behaviour matches exactly).

const { TF_CONFIG, pickExpiry, scanTicker, safeChgPct } = require('../_lib/scanLogic')
const { getFundamentals } = require('../_lib/fundamentals')
const { SP500 } = require('../_lib/sp500')

const TRADIER_MODE  = process.env.TRADIER_MODE  || 'production'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || ''
const TRADIER_BASE  = TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'
const CRON_SECRET   = process.env.CRON_SECRET || ''

// Lazy Supabase singleton — never crash the module on import if env vars are
// briefly missing during a deploy race (same defensive pattern as fundamentals.js,
// learned from a prior production outage caused by a top-level require crash).
let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[cron/scan] supabase init failed:', e.message) }
  }
  return _sb
}

// ─── Tradier rate-limit health check ───────────────────────────────────────
// Temporary diagnostic instrumentation (see README-health-check.md for the
// plan this is part of). Tradier sends X-Ratelimit-* headers on every market-
// data response: Allowed, Used, Available, Expiry (docs.tradier.com/docs/rate-limiting).
// Production limit is 120/min, enforced per-token. This module never throttles
// or changes behavior — it only OBSERVES and logs, so it's safe to ship and
// leave running without any risk to existing scan behavior.
//
// Tracker is passed explicitly through every call (not module-scope) because
// Fluid Compute can route concurrent invocations to the same warm instance —
// module-scope state would let two overlapping runs corrupt each other's counts.
function newRateTracker() {
  return {
    calls: 0,                  // total Tradier calls this invocation
    statusCounts: {},           // e.g. {200: 1020, 429: 6}
    minAvailable: null,         // lowest X-Ratelimit-Available seen — closest we got to the wall
    minAvailableAt: null,       // ISO timestamp of that low point, for correlating with batch position
    firstAllowed: null,         // X-Ratelimit-Allowed, sanity-check against the documented 120
    sawRetryAfter: null,        // Retry-After value if any 429 included one
  }
}
function recordRateHeaders(tracker, r) {
  if (!tracker) return
  tracker.calls++
  tracker.statusCounts[r.status] = (tracker.statusCounts[r.status] || 0) + 1
  const allowed   = parseInt(r.headers.get('x-ratelimit-allowed'), 10)
  const available = parseInt(r.headers.get('x-ratelimit-available'), 10)
  if (!isNaN(allowed) && tracker.firstAllowed === null) tracker.firstAllowed = allowed
  if (!isNaN(available) && (tracker.minAvailable === null || available < tracker.minAvailable)) {
    tracker.minAvailable = available
    tracker.minAvailableAt = new Date().toISOString()
  }
  if (r.status === 429) {
    const retryAfter = r.headers.get('retry-after')
    if (retryAfter) tracker.sawRetryAfter = retryAfter
  }
}
function logRateSummary(tf, tracker, durationMs) {
  if (!tracker) return
  const wasThrottled = (tracker.statusCounts[429] || 0) > 0
  console.log(`[rate-check] tf=${tf} calls=${tracker.calls} durationMs=${durationMs} ` +
    `statusCounts=${JSON.stringify(tracker.statusCounts)} ` +
    `allowed=${tracker.firstAllowed ?? 'n/a'} minAvailable=${tracker.minAvailable ?? 'n/a'} ` +
    `minAvailableAt=${tracker.minAvailableAt ?? 'n/a'} ` +
    `throttled429=${wasThrottled}${tracker.sawRetryAfter ? ` retryAfter=${tracker.sawRetryAfter}` : ''}`)
  if (wasThrottled) {
    console.warn(`[rate-check] ⚠️ THROTTLED — tf=${tf} hit ${tracker.statusCounts[429]} HTTP 429(s) ` +
      `from Tradier this run. These were previously silently treated as "no data" for those ` +
      `tickers — same root cause as a missed quote, just now visible.`)
  } else if (tracker.minAvailable !== null && tracker.minAvailable <= 10) {
    console.warn(`[rate-check] ⚠️ CLOSE TO LIMIT — tf=${tf} minAvailable=${tracker.minAvailable} ` +
      `(out of ${tracker.firstAllowed ?? 120}) at ${tracker.minAvailableAt} — no 429 yet this run, ` +
      `but headroom was thin.`)
  }
}

async function tFetch(path, tracker) {
  const url = `${TRADIER_BASE}${path}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } })
  recordRateHeaders(tracker, r)
  if (!r.ok) return null
  try { return await r.json() } catch { return null }
}
const getQuote    = async (sym, tracker) => { const d = await tFetch(`/markets/quotes?symbols=${sym}&greeks=false`, tracker); return d?.quotes?.quote || null }
const getExpiries = async (sym, tracker) => { const d = await tFetch(`/markets/options/expirations?symbol=${sym}&includeAllRoots=false`, tracker); return d?.expirations?.date || [] }
const getChain     = async (sym, exp, tracker) => { const d = await tFetch(`/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=true`, tracker); return d?.options?.option || [] }

// Batched concurrency helper — runs `worker` over `items`, `batchSize` at a time.
async function runBatched(items, batchSize, worker) {
  const out = []
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize)
    const results = await Promise.all(slice.map(worker))
    out.push(...results)
  }
  return out
}

module.exports = async function handler(req, res) {
  // Vercel Cron calls this with a special header; also accept a manual secret
  // so this can be triggered for testing without waiting for the schedule.
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
                     || req.headers['x-vercel-cron'] === '1'   // secondary signal — covers
                                                                // the rare case CRON_SECRET
                                                                // doesn't arrive in the header
  const isManualTrigger = req.query.secret && req.query.secret === CRON_SECRET
  if (!isVercelCron && !isManualTrigger && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized — cron secret missing/invalid' })
  }

  const tf = req.query.tf || 'Swing (21–45 DTE)'
  const tfCfg = TF_CONFIG[tf]
  if (!tfCfg) {
    // Fails loudly rather than silently — a mismatched dash character or
    // URL-encoding quirk between vercel.json's cron path and TF_CONFIG's keys
    // would otherwise just 400 with no trace in the cron's own dashboard.
    console.error(`[cron/scan] Unknown timeframe "${tf}" — known keys: ${Object.keys(TF_CONFIG).join(', ')}`)
    return res.status(400).json({ error: `Unknown timeframe: ${tf}`, knownKeys: Object.keys(TF_CONFIG) })
  }

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  const startedAt = Date.now()
  const MAX_MS = 280_000   // leave 20s headroom under the 300s Pro maxDuration
  const MIN_WRITE_SCORE = 60   // only persist results worth surfacing — raise this
                               // (e.g. to 65 or 70) if the table still feels noisy
  const rateTracker = newRateTracker()   // local to this invocation — see note above on why not module-scope

  // Market regime — fetched once per run, shared across all tickers (mirrors
  // esBar/nqBar in the frontend, which are also fetched once and reused).
  let spxChg = 0, ndxChg = 0
  try {
    const [spxQ, ndxQ] = await Promise.all([getQuote('SPX', rateTracker), getQuote('NDX', rateTracker)])
    spxChg = safeChgPct(spxQ).pct
    ndxChg = safeChgPct(ndxQ).pct
  } catch (e) { console.error('[cron/scan] market regime fetch failed:', e.message) }

  const tickers = SP500
  let scanned = 0, qualified = 0, errors = 0

  await runBatched(tickers, 8, async (ticker) => {
    if (Date.now() - startedAt > MAX_MS) return null   // time budget guard

    try {
      const [quote, expDates] = await Promise.all([getQuote(ticker, rateTracker), getExpiries(ticker, rateTracker)])
      if (!quote || !expDates.length) { scanned++; return null }
      const price = parseFloat(quote.last || quote.prevclose || 0)
      if (!price) { scanned++; return null }
      const expiryRaw = pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
      const chain = await getChain(ticker, expiryRaw, rateTracker)
      if (!chain.length) { scanned++; return null }

      const r = scanTicker({ ticker, quote, expDates, chain, tf, fund: null, spxChg, ndxChg })
      scanned++
      if (!r) return null

      // Below-threshold results are intentionally NOT written to scan_results —
      // a previous version wrote every scored ticker regardless, which silently
      // filled the table with ~70% C-grade noise (avg score 47) because this
      // gate only wrapped the fundamentals fetch, not the write itself.
      if (r.score < MIN_WRITE_SCORE) return null

      // Fundamentals only fetched for tickers worth showing — same rationale
      // as the earlier client-side fix: don't spend API budget on misses.
      const fund = await getFundamentals(ticker).catch(() => null)
      if (fund) {
        // Re-run with fundamentals to apply the large-cap/earnings adjustments
        const r2 = scanTicker({ ticker, quote, expDates, chain, tf, fund, spxChg, ndxChg })
        if (r2) Object.assign(r, r2)
      }

      const scannedAt = new Date()
      const expiresAt = new Date(scannedAt.getTime() + 20 * 60 * 1000)   // 20 min TTL

      const row = {
        ticker, timeframe: tf, score: r.score, grade: r.grade,
        trade_type: r.tradeType, strike_str: r.strikeStr,
        mid: r.mid, bid: r.bid, ask: r.ask,
        entry: r.entry, target: r.target, stop: r.stop,
        breakeven: r.breakeven, breakeven_pct: r.breakevenPct,
        dte: r.dte, iv: r.iv, delta: r.delta, chg_pct: r.chgPct,
        volume: r.volume, oi: r.oi,
        reasons: r.reasons, warnings: r.warnings, hard_blocks: r.hardBlocks,
        sector: r.sector, industry: r.industry, market_cap: r.marketCap,
        earnings_date: r.earningsDate, expiry_display: r.expiryDisplay,
        scanned_at: scannedAt.toISOString(), expires_at: expiresAt.toISOString(),
      }

      const { error } = await client.from('scan_results').upsert(row, { onConflict: 'ticker,timeframe' })
      if (error) { console.error(`[cron/scan] upsert failed for ${ticker}:`, error.message); errors++; return null }

      qualified++
      return r
    } catch (e) {
      console.error(`[cron/scan] ${ticker} failed:`, e.message)
      errors++
      return null
    }
  })

  const durationMs = Date.now() - startedAt
  console.log(`[cron/scan] tf=${tf} scanned=${scanned} qualified=${qualified} errors=${errors} duration=${durationMs}ms`)
  logRateSummary(tf, rateTracker, durationMs)

  return res.status(200).json({
    timeframe: tf, scanned, qualified, errors, durationMs,
    truncated: durationMs > MAX_MS,
    rateHealth: {
      tradierCalls: rateTracker.calls,
      statusCounts: rateTracker.statusCounts,
      allowed: rateTracker.firstAllowed,
      minAvailable: rateTracker.minAvailable,
      throttled429: (rateTracker.statusCounts[429] || 0) > 0,
    },
  })
}
