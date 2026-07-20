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
const { getTrendContext, getVix } = require('../_lib/trendContext')
const { getRecentNewsSignal } = require('../_lib/newsSignal')
const crypto = require('crypto')

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
  if (r.status === 400) console.warn(`[cron/scan] HTTP_400 ${path}`)
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
  if (r.status === 400) console.warn(`[cron/scan] HTTP_400 ${path} body=${body}`)
  if (!r.ok) return null
  try { return await r.json() } catch { return null }
}
const getQuote    = async (sym, tracker) => { const d = await tFetch(`/markets/quotes?symbols=${sym}&greeks=false`, tracker); return d?.quotes?.quote || null }
const getExpiries = async (sym, tracker) => { const d = await tFetch(`/markets/options/expirations?symbol=${sym}&includeAllRoots=false`, tracker); return d?.expirations?.date || [] }
const getChain     = async (sym, exp, tracker) => { const d = await tFetch(`/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=true`, tracker); return d?.options?.option || [] }

// getHistory: generic /markets/history, symbol-agnostic — works for stock
// tickers and index/VIX symbols, not just options, exactly like
// tradierClient.js's getOptionHistory (which despite its name hits the same
// generic endpoint). Added 2026-07-18 for the trend-context feature — scan.js
// didn't previously need historical daily bars for anything. Same
// bare-object-vs-array normalization as getChain/getOptionHistory above,
// since Tradier's XML->JSON quirk applies here too.
const getHistory = async (sym, startDate, endDate, tracker) => {
  const d = await tFetch(`/markets/history?symbol=${sym}&interval=daily&start=${startDate}&end=${endDate}`, tracker)
  const days = d?.history?.day
  if (!days) return []
  return Array.isArray(days) ? days : [days]
}

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

  // VIX — added 2026-07-18, LOG ONLY (not wired into scoring). See
  // trendContext.js top-of-file comment for why: no new signal goes into
  // live scoring without a log-first-then-validate period against real
  // resolved outcomes first, per this week's 52w-bonus and momentum lessons.
  const vix = await getVix(getQuote, rateTracker).catch(() => ({ level: null, chgPct: null }))

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

  const bufferedRows = []

  // Incumbent-side lookup for hysteresis (pickBetterSide) — one query for
  // the whole run, not one per ticker. Confirmed live need: GOOGL Quick
  // Play flipped call/put every 15 min on 2026-07-10 because chg_pct sat
  // right at the 1.5% hasRealSignal cliff; pickBetterSide now requires a
  // real margin to flip away from whatever's currently shown, using this
  // map to know what that currently is.
  const incumbentMap = new Map()
  try {
    const { data: currentRows, error: incumbentErr } = await client
      .from('scan_results')
      .select('ticker, trade_type')
      .eq('timeframe', tf)
    if (incumbentErr) {
      console.error('[cron/scan] incumbent-side lookup failed (non-fatal, hysteresis disabled this run):', incumbentErr.message)
    } else {
      for (const row of currentRows || []) {
        const side = /put/i.test(row.trade_type || '') ? 'put' : /call/i.test(row.trade_type || '') ? 'call' : null
        if (side) incumbentMap.set(row.ticker, side)
      }
    }
  } catch (e) {
    console.error('[cron/scan] incumbent-side lookup threw (non-fatal, hysteresis disabled this run):', e.message)
  }

  await runBatched(tickers, 8, async (ticker) => {
    if (Date.now() - startedAt > MAX_MS) return null   // time budget guard

    try {
      const quote = quoteMap.get(ticker)
      const expDates = await getExpiries(ticker, rateTracker)
      if (!quote || !expDates.length) { scanned++; return null }
      const price = parseFloat(quote.last || quote.prevclose || 0)
      if (!price) { scanned++; return null }
      const { date: expiryRaw } = pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
      const chain = await getChain(ticker, expiryRaw, rateTracker)
      if (!chain.length) { scanned++; return null }

      const r = scanTicker({ ticker, quote, expDates, chain, tf, fund: null, spxChg, ndxChg, srLevels: null, incumbentSide: incumbentMap.get(ticker) || null })
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
      const [fund, srLevels, trendContext, newsSignal] = await Promise.all([
        getFundamentals(ticker).catch(() => null),
        getSRLevels(ticker).catch(() => null),
        // Trend context — added 2026-07-18. Gated the same way as fund/srLevels
        // (score≥MIN_WRITE_SCORE already, this is the second pass) rather than
        // fetched for the full universe — same "don't spend API budget on
        // misses" rationale as the comment above this block.
        getTrendContext(ticker, null, getHistory, rateTracker).catch(() => ({ direction: 'unknown', sma50: null, sma200: null })),
        // Per-ticker news — added 2026-07-20, Phase 2 piece 2. Quick ONLY,
        // per the target design (Quick=market/news, Swing+=technical/
        // fundamental) — resolves instantly to null for other timeframes,
        // no network call, same "don't fetch what you won't use" discipline.
        // LOG ONLY, see newsSignal.js header — presence/count, not
        // sentiment, not wired into scoring.
        tf === 'Quick (5–14 DTE)' ? getRecentNewsSignal(ticker).catch(() => ({ count: null, headlines: [] })) : Promise.resolve(null),
      ])
      if (fund || srLevels) {
        // Re-run with fundamentals AND S/R to apply large-cap/earnings
        // adjustments and the S/R structure scoring block.
        const r2 = scanTicker({ ticker, quote, expDates, chain, tf, fund, spxChg, ndxChg, srLevels, incumbentSide: incumbentMap.get(ticker) || null, trendContext })
        if (r2) Object.assign(r, r2)
      }

      const scannedAt = new Date()
      const expiresAt = new Date(scannedAt.getTime() + 20 * 60 * 1000)   // 20 min TTL

      // ── Signal lifecycle grouping (2026-06-29) ──────────────────────────
      // Confirmed live: the SAME contract (ticker+option_type+strike+expiry)
      // gets a fresh signal_history row every single time it re-qualifies —
      // 15-60 min apart, depending on timeframe — for as long as it stays
      // above the conviction threshold. One real contract observed 36x in a
      // single day. This is genuinely useful for QA (does score drift as
      // the day goes on?), which is why every row still gets written below,
      // unchanged — but it means a naive "count every signal_history row as
      // one outcome" win-rate would weight that one persistent setup 36x
      // more than a contract that only qualified once. Per explicit
      // decision: keep every row (preserve the QA history), but tag rows
      // belonging to the same real-world signal with a shared
      // signal_lifecycle_id, and mark only the FIRST (entry) row of each
      // lifecycle as is_lifecycle_primary — that's the one the resolver
      // should actually walk for WIN/LOSS, and the one Track Record/
      // Conviction Correlation should count, since entry_mid/target/stop
      // are computed from that first scan's price, the economically real
      // entry point. A lifecycle is "still open" as long as no row in it
      // has a non-null outcome yet.
      //
      // Moved above the scan_results row below (was previously computed
      // after it) — scan_results now also carries signal_lifecycle_id, so
      // the live card can be joined back to its own full re-scan history
      // (score/premium trajectory, setup age) via /api/scan-cache.
      let lifecycleId = null
      let isLifecyclePrimary = true
      try {
        const { data: existingLifecycle, error: lifecycleErr } = await client
          .from('signal_history')
          .select('signal_lifecycle_id')
          .eq('ticker', ticker)
          .eq('option_type', r.optionType)
          .eq('primary_strike', r.primaryStrikeRaw)
          .eq('expiry_raw', r.expiryRaw)
          .is('outcome', null)
          .not('signal_lifecycle_id', 'is', null)
          .order('scanned_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        if (lifecycleErr) {
          console.error(`[cron/scan] lifecycle lookup failed for ${ticker} (non-fatal, will start a new lifecycle):`, lifecycleErr.message)
        } else if (existingLifecycle) {
          lifecycleId = existingLifecycle.signal_lifecycle_id
          isLifecyclePrimary = false
        }
      } catch (e) {
        console.error(`[cron/scan] lifecycle lookup threw for ${ticker} (non-fatal):`, e.message)
      }
      if (!lifecycleId) lifecycleId = crypto.randomUUID()

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
        // expiry_raw — ISO date (e.g. "2026-07-17"), as opposed to
        // expiry_display's human-readable form ("Jul 17, 2026"). Added
        // because pushToJournal (App.jsx) was forwarding expiry_display
        // into trades.expiration, which buildOccSymbol cannot parse —
        // confirmed live: produced a garbage OCC symbol, Tradier correctly
        // found no quote for it, the verdict-check cron logged it as
        // "no_quote" rather than scoring the position. r.expiryRaw already
        // exists on scanTicker's return object (scanLogic.js) — this was a
        // forward-the-existing-field fix, not new computation.
        expiry_raw: r.expiryRaw,
        is_fallback_expiry: r.isFallbackExpiry || false,
        direction_decision: r.directionDecision || null,
        // underlying_price — the live stock price at scan time. Was already
        // captured into signal_history (r.priceRaw, below) but never carried
        // into scan_results, which is what the Scan tab UI actually reads
        // (via /api/scan-cache) — so a user had no way to see how far a
        // strike sat from the real, live price at the moment it was scored.
        // Confirmed live: a PANW $305C scored at 95 conviction with the
        // stock already at ~$325 (real, not stale — verified against
        // Black-Scholes backward-solve, not assumed), and nothing on the
        // card showed that gap. Forward-the-existing-field fix, same shape
        // as expiry_raw's own comment above — r.priceRaw already existed,
        // this was never computed here, just never written to this table.
        underlying_price: r.priceRaw || null,
        signal_lifecycle_id: lifecycleId,
        scanned_at: scannedAt.toISOString(), expires_at: expiresAt.toISOString(),
      }

      const { error } = await client.from('scan_results').upsert(row, { onConflict: 'ticker,timeframe' })
      if (error) { console.error(`[cron/scan] upsert failed for ${ticker}:`, error.message); errors++; return null }

      // Append-only permanent record for engine-level success-rate QA (Phase 1).
      // Distinct from scan_results above: never upserted/overwritten, never
      // expires, and a failure here must NOT fail the scan or block scan_results
      // (which is what the live UI depends on) — log and move on.
      const historyRow = {
        ticker, timeframe: tf, tf_label: r.tfLabel,
        trade_type: r.tradeType, option_type: r.optionType,
        direction_decision: r.directionDecision || null,
        primary_strike: r.primaryStrikeRaw, expiry_raw: r.expiryRaw,
        score: r.score, grade: r.grade,
        reasons: r.reasons, warnings: r.warnings, hard_blocks: r.hardBlocks,
        entry_mid: r.midRaw, bid: r.bidRaw, ask: r.askRaw,
        underlying_price: r.priceRaw, iv: r.ivRaw, delta: r.deltaRaw,
        chg_pct: parseFloat(r.chgPct) || null,
        volume: r.volume, open_interest: r.oi, dte_at_signal: r.dte,
        is_fallback_expiry: r.isFallbackExpiry || false,
        profit_target_pct: r.profitTargetPct, stop_loss_pct: r.stopLossPct,
        sector: r.sector, industry: r.industry, market_cap: r.marketCap,
        earnings_date: r.earningsDate,
        signal_lifecycle_id: lifecycleId,
        is_lifecycle_primary: isLifecyclePrimary,
        scanned_at: scannedAt.toISOString(),
        // Regime context at scan time — same spxChg/ndxChg values already
        // computed above and fed into scoreConviction's tailwind/headwind
        // term (see convictionScore.cjs), but never persisted before this.
        // Logged only, not yet used to filter/score/gate anything new —
        // per session decision: accumulate this across multiple scan days
        // before drawing any conclusion from it, same discipline applied
        // to every other finding this session. NOTE: this is a SAME-DAY
        // (single trading session) index move, not a multi-day trend —
        // it tells you the regime at the moment of entry, not the regime
        // that plays out over a 21-45 DTE swing trade's actual holding
        // period. Do not treat a lack of predictive power here as proof
        // regime doesn't matter; it may just mean this particular window
        // is too short for this timeframe. A longer-horizon version
        // (e.g. 5-day SPX/NDX trend, VIX level) is a separate, slightly
        // more expensive follow-up (new Tradier call) once this cheaper
        // same-day version has been checked against real data.
        regime_spx_chg_pct: spxChg,
        regime_ndx_chg_pct: ndxChg,
        // Long-term trend + VIX — added 2026-07-18, the anticipated follow-up
        // noted in the comment above (same-day regime alone can't explain
        // multi-week Swing performance; see trendContext.js for the analysis
        // that motivated this). long_term_trend feeds a scoring dampener for
        // counter-trend Swing/LEAP/Deep LEAP setups (see convictionScore.cjs).
        // vix_level/vix_chg_pct are LOG ONLY — not wired into scoring yet,
        // same log-first-then-validate discipline as regime_spx_chg_pct above.
        long_term_trend: trendContext?.direction || null,
        vix_level: vix.level,
        vix_chg_pct: vix.chgPct,
        // Shadow vertical spread — added 2026-07-19, Phase 1 of the
        // re-architecture roadmap. LOG ONLY, same discipline as vix_level
        // above: never read by scoring or the live displayed signal. Stored
        // as JSONB (same pattern as direction_decision) rather than one
        // column per field, since this is an evolving shadow structure we
        // expect to iterate on before it's ever promoted to a real feature.
        shadow_vertical_spread: r.shadowSpread || null,
        // Phase 2 shadow reweight (2026-07-20) — see convictionScore.cjs
        // TF_WEIGHT_PROFILES comment. Never affects the live score/signal.
        shadow_technical_reweight_score: r.shadowTechnicalReweightScore ?? null,
        // Measurement infrastructure — added 2026-07-21, per outside review.
        // Neither affects scoring or the live signal; both are logged for
        // future analysis. See scanLogic.js/convictionScore.cjs for details.
        scoring_model_version: r.scoringModelVersion || null,
        entry_spread_pct: r.entrySpreadPct ?? null,
        // Per-ticker news presence — added 2026-07-20, Phase 2 piece 2.
        // Quick only (null for other timeframes by construction — newsSignal
        // itself is null there, see the Promise.all gate above). LOG ONLY —
        // presence/count, not sentiment, not wired into scoring. See
        // newsSignal.js header for why sentiment is explicitly out of scope
        // for this piece.
        shadow_recent_news_count: newsSignal?.count ?? null,
        shadow_recent_news_headlines: newsSignal?.headlines?.length ? newsSignal.headlines : null,
      }
      bufferedRows.push(historyRow)

      qualified++
      return r
    } catch (e) {
      console.error(`[cron/scan] ${ticker} failed:`, e.message)
      errors++
      return null
    }
  })

  // Directional concentration flag — same-run signals aren't independent
  // bets when one side dominates; 46 puts vs 42 calls firing in one day
  // (June 26 cohort) meant losses on the put side were effectively one
  // large correlated position, not 46 separate ones. This only adds a
  // warning to the over-represented side's rows — it never filters or
  // blocks a signal, so it can't introduce a new false-negative or hide
  // a genuinely good setup. Threshold and minimum batch size are both
  // untuned starting points, not derived from validated data — revisit
  // once there's evidence on what ratio actually predicts correlated
  // drawdowns, same discipline as every other unvalidated change this
  // session.
  const CONCENTRATION_THRESHOLD = 0.65
  const MIN_BATCH_FOR_CHECK = 10
  const callRows = bufferedRows.filter(r => r.option_type === 'call')
  const putRows  = bufferedRows.filter(r => r.option_type === 'put')
  const totalDirectional = callRows.length + putRows.length
  if (totalDirectional >= MIN_BATCH_FOR_CHECK) {
    const callPct = callRows.length / totalDirectional
    const putPct  = putRows.length / totalDirectional
    if (callPct >= CONCENTRATION_THRESHOLD) {
      const msg = `⚠ ${callRows.length}/${totalDirectional} (${(callPct*100).toFixed(0)}%) of this scan's signals are calls — correlated market-wide bet, not independent conviction`
      for (const row of callRows) row.warnings = [...(row.warnings || []), msg]
    } else if (putPct >= CONCENTRATION_THRESHOLD) {
      const msg = `⚠ ${putRows.length}/${totalDirectional} (${(putPct*100).toFixed(0)}%) of this scan's signals are puts — correlated market-wide bet, not independent conviction`
      for (const row of putRows) row.warnings = [...(row.warnings || []), msg]
    }
  }

  // Bulk insert, with per-row fallback if the batch insert fails as a whole
  // — a single malformed row previously couldn't block other tickers'
  // writes (each was inserted independently); buffering for the
  // concentration check above changed that, so fault isolation is
  // restored explicitly here rather than silently lost.
  if (bufferedRows.length) {
    const { error: bulkErr } = await client.from('signal_history').insert(bufferedRows)
    if (bulkErr) {
      console.error(`[cron/scan] bulk signal_history insert failed (${bufferedRows.length} rows), falling back to per-row insert:`, bulkErr.message)
      for (const row of bufferedRows) {
        const { error: rowErr } = await client.from('signal_history').insert(row)
        if (rowErr) console.error(`[cron/scan] signal_history insert failed for ${row.ticker} (non-fatal):`, rowErr.message)
      }
    }
  }

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
