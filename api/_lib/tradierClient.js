// api/_lib/tradierClient.js
//
// Shared server-side Tradier client (rate-tracked) for the new outcome-
// resolver cron (api/cron/resolve-outcomes.js). The rate-tracking and tFetch
// logic here is intentionally identical to api/cron/scan.js's inline version
// — copied, not imported, on purpose: refactoring scan.js (the live,
// revenue-critical scan cron) to consume this shared module was deliberately
// deferred rather than risked in the same change as building a brand-new,
// not-yet-production-tested resolver. If scan.js is ever touched for an
// unrelated reason, consider migrating it to import from here instead of
// maintaining two copies — but that's a separate, lower-urgency cleanup,
// not a prerequisite for this file.

const TRADIER_MODE  = process.env.TRADIER_MODE  || 'production'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || ''
const TRADIER_BASE  = TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'

// ─── Tradier rate-limit health check ───────────────────────────────────────
// Tradier sends X-Ratelimit-* headers on every market-data response: Allowed,
// Used, Available, Expiry (docs.tradier.com/docs/rate-limiting). Production
// limit is 120/min, enforced per-token, SHARED across every caller using this
// token — including the scan cron and this resolver. Tracker is passed
// explicitly through every call (not module-scope) because Fluid Compute can
// route concurrent invocations to the same warm instance — module-scope state
// would let two overlapping runs corrupt each other's counts.
function newRateTracker() {
  return {
    calls: 0,
    statusCounts: {},
    minAvailable: null,
    minAvailableAt: null,
    firstAllowed: null,
    sawRetryAfter: null,
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
function logRateSummary(label, tracker, durationMs) {
  if (!tracker) return
  const wasThrottled = (tracker.statusCounts[429] || 0) > 0
  console.log(`[rate-check] ${label} calls=${tracker.calls} durationMs=${durationMs} ` +
    `statusCounts=${JSON.stringify(tracker.statusCounts)} ` +
    `allowed=${tracker.firstAllowed ?? 'n/a'} minAvailable=${tracker.minAvailable ?? 'n/a'} ` +
    `minAvailableAt=${tracker.minAvailableAt ?? 'n/a'} ` +
    `throttled429=${wasThrottled}${tracker.sawRetryAfter ? ` retryAfter=${tracker.sawRetryAfter}` : ''}`)
  if (wasThrottled) {
    console.warn(`[rate-check] ⚠️ THROTTLED — ${label} hit ${tracker.statusCounts[429]} HTTP 429(s) ` +
      `from Tradier this run.`)
  } else if (tracker.minAvailable !== null && tracker.minAvailable <= 10) {
    console.warn(`[rate-check] ⚠️ CLOSE TO LIMIT — ${label} minAvailable=${tracker.minAvailable} ` +
      `(out of ${tracker.firstAllowed ?? 120}) at ${tracker.minAvailableAt} — no 429 yet this run, ` +
      `but headroom was thin. NOTE: this token is shared with the scan cron — ` +
      `check whether both jobs' windows are overlapping if this fires often.`)
  }
}

async function tFetch(path, tracker) {
  const url = `${TRADIER_BASE}${path}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } })
  recordRateHeaders(tracker, r)
  if (!r.ok) return null
  try { return await r.json() } catch { return null }
}
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
const getChain    = async (sym, exp, tracker) => { const d = await tFetch(`/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=true`, tracker); return d?.options?.option || [] }

// ── New for the outcome resolver (Phase 2) ──────────────────────────────────
// Daily OHLC for an OCC option symbol. Used as a cheap pre-check before
// pulling 1-min bars — see resolve-outcomes.js step 1.
// Confirmed live against production Tradier (curl test, June 2026): returns
// real daily bars for option symbols when passed in OCC format
// (e.g. AAPL260717P00275000).
const getOptionHistory = async (occSymbol, startDate, endDate, tracker) => {
  const d = await tFetch(
    `/markets/history?symbol=${occSymbol}&interval=daily&start=${startDate}&end=${endDate}`,
    tracker
  )
  const days = d?.history?.day
  if (!days) return []
  // FIX: confirmed live — Tradier returns a bare object (not an array) for
  // /markets/history when the range covers exactly one day, same pattern
  // already known from the batch quotes endpoint (sp500.js) and already
  // guarded in getOptionTimesales below. Missing this here caused the
  // resolver to silently skip days that DID have crossable price data,
  // misreading a real stop-loss hit as "no data this day" — caught during
  // manual verification against a backdated test row (AAPL, June 25) before
  // this shipped to the full backlog.
  return Array.isArray(days) ? days : [days]
}
// 1-min bars for an OCC option symbol, for one calendar day at a time.
// startDateTime/endDateTime format: 'YYYY-MM-DD HH:MM' (ET, per Tradier docs).
// Confirmed live: returns real OHLCV bars for option symbols (curl test,
// June 2026 — see Phase 2 resolver spec, section 1).
const getOptionTimesales = async (occSymbol, startDateTime, endDateTime, tracker) => {
  const d = await tFetch(
    `/markets/timesales?symbol=${occSymbol}&interval=1min&start=${encodeURIComponent(startDateTime)}&end=${encodeURIComponent(endDateTime)}`,
    tracker
  )
  const bars = d?.series?.data
  if (!bars) return []
  // Tradier returns a bare object (not an array) when there's exactly one bar
  // — same single-vs-array normalization issue already known from the batch
  // quotes endpoint (see sp500.js usage in scan.js). Guard it here too.
  return Array.isArray(bars) ? bars : [bars]
}

module.exports = {
  TRADIER_TOKEN, TRADIER_BASE,
  newRateTracker, recordRateHeaders, logRateSummary,
  tFetch, tFetchPost,
  getQuote, getExpiries, getChain,
  getOptionHistory, getOptionTimesales,
}
