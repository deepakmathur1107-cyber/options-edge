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
const { getSRLevels } = require('../_lib/srLevels')
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
// POST variant — Tradier documents POST /markets/quotes specifically for "a larger
// list of symbols" (docs.tradier.com/reference/brokerage-api-markets-post-quotes),
// separate from the GET form used for single/few-symbol lookups. Using POST avoids
// any URL-length concern from a long comma-joined symbol list in a query string.
async function tFetchPost(path, body, tracker) {
  const url = `${TRADIER_BASE}${path}`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TRADIER_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  recordRateHeaders(tracker, r)
  if (!r.ok) return null
  try { return await r.json() } catch { return null }
}
const getQuote    = async (sym, tracker) => { const d = await tFetch(`/markets/quotes?symbols=${sym}&greeks=false`, tracker); return d?.quotes?.quote || null }
const getExpiries = async (sym, tracker) => { const d = await tFetch(`/markets/options/expirations?symbol=${sym}&includeAllRoots=false`, tracker); return d?.expirations?.date || [] }
const getChain     = async (sym, exp, tracker) => { const d = await tFetch(`/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=true`, tracker); return d?.options?.option || [] }

// BATCH_SIZE: conservative choice. Tradier's own docs don't publish a documented
// max-symbols-per-call number for /markets/quotes (only third-party sources claim
// "100" — not confirmed against Tradier's own documentation), so this stays well
// under any plausible limit rather than assuming one. Tune up later once observed
// to work reliably in production (check rate-check logs for any 400s on this call).
const QUOTE_BATCH_SIZE = 50

// getQuotesBatch: fetches quotes for MANY symbols in ONE Tradier call instead of
// one call per symbol. This is the fix for the rate-limit headroom problem
// confirmed via the rate-check instrumentation (minAvailable hit 0/120 during a
// normal scheduled run) — quote calls were 1/3 of total Tradier traffic (one per
// ticker) and collapse to ~7 calls for the full 342-ticker universe instead of 342.
//
// IMPORTANT: Tradier's JSON is produced via an XML->JSON translation with a known
// quirk (docs.tradier.com/docs/response-format) — a single-result list can come
// back as a bare object instead of an array. This function normalizes that so
// callers always get a Map, regardless of how many symbols matched.
async function getQuotesBatch(symbols, tracker) {
  const map = new Map()
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH_SIZE) {
    const slice = symbols.slice(i, i + QUOTE_BATCH_SIZE)
    const body = `symbols=${encodeURIComponent(slice.join(','))}&greeks=false`
    const d = await tFetchPost('/markets/quotes', body, tracker)
    let quotes = d?.quotes?.quote
    if (!quotes) continue
    if (!Array.isArray(quotes)) quotes = [quotes]   // normalize single-object case
    for (const q of quotes) {
      if (q && q.symbol) map.set(q.symbol, q)
    }
  }
  return map
}

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

  // Fetch all quotes up front, batched (≤QUOTE_BATCH_SIZE symbols per Tradier call)
  // instead of one Tradier call per ticker inside the loop below. This is the fix
  // for the rate-limit headroom problem the rate-check instrumentation confirmed
  // live (minAvailable hit 0/120 on a normal run) — quotes were 342 of the ~1,015
  // Tradier calls in a full run; this collapses that to ~7 calls.
  let quoteMap = new Map()
  try {
    quoteMap = await getQuotesBatch(tickers, rateTracker)
    console.log(`[cron/scan] batch quotes: resolved ${quoteMap.size}/${tickers.length} tickers in ${Math.ceil(tickers.length/QUOTE_BATCH_SIZE)} Tradier call(s)`)
  } catch (e) { console.error('[cron/scan] batch quote fetch failed:', e.message) }

  await runBatched(tickers, 8, async (ticker) => {
    if (Date.now() - startedAt > MAX_MS) return null   // time budget guard

    try {
      const quote = quoteMap.get(ticker)
      const expDates = await getExpiries(ticker, rateTracker)
      if (!quote || !expDates.length) { scanned++; return null }
      const price = parseFloat(quote.last || quote.prevclose || 0)
      if (!price) { scanned++; return null }
      const expiryRaw = pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
      const chain = await getChain(ticker, expiryRaw, rateTracker)
      if (!chain.length) { scanned++; return null }

      const r = scanTicker({ ticker, quote, expDates, chain, tf, fund: null, spxChg, ndxChg, srLevels: null })
      scanned++
      if (!r) return null

      // Below-threshold results are intentionally NOT written to scan_results —
      // a previous version wrote every scored ticker regardless, which silently
      // filled the table with ~70% C-grade noise (avg score 47) because this
      // gate only wrapped the fundamentals fetch, not the write itself.
      if (r.score < MIN_WRITE_SCORE) return null

      // Fundamentals + S/R levels only fetched for tickers worth showing — same
      // rationale as the earlier client-side fix: don't spend API budget on
      // misses. Gated on the FIRST (pre-fundamentals, pre-S/R) score, same point
      // fundamentals was already gated at — see scanTicker's two-sided scoring
      // comment for why that means a ticker fundamentals later pushes from 58
      // to 61 won't retroactively get S/R either; accepted as a minor edge case
      // rather than a second full re-score pass just to re-evaluate the gate.
      //
      // NOTE — rate-limit visibility gap: getSRLevels makes its own Tradier
      // /markets/history call via a raw fetch() in srLevels.js, NOT through this
      // file's tFetch/rateTracker wrapper. That means S/R fetches are invisible
      // to the rate-check instrumentation above (recordRateHeaders/minAvailable)
      // — exactly the kind of untracked API consumer that instrumentation was
      // built to catch after the previous 429 incident. Only ~qualified tickers
      // (score≥60) hit this per run, so volume is much lower than the 342-ticker
      // quote/chain calls, but it is a real blind spot worth closing in a
      // follow-up (route srLevels.js through the shared tFetch helper) rather
      // than silently accepting it indefinitely.
      const [fund, srLevels] = await Promise.all([
        getFundamentals(ticker).catch(() => null),
        getSRLevels(ticker).catch(() => null),
      ])
      if (fund || srLevels) {
        // Re-run with fundamentals AND S/R to apply large-cap/earnings
        // adjustments and the S/R structure scoring block.
        const r2 = scanTicker({ ticker, quote, expDates, chain, tf, fund, spxChg, ndxChg, srLevels })
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
        direction_decision: r.directionDecision || null,
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
