// api/_lib/verdictCheck.js
//
// Item 5 — hold/close verdict engine, core scoring piece. Deliberately does
// NOT reuse scanTicker/buildNakedResult: those SELECT a new best contract
// from a chain (best strike, best expiry within a DTE window) — exactly
// wrong for this purpose, which is re-evaluating the ONE specific contract
// a user already holds (trades.strike / trades.expiration / trades.option_type).
// Running scanTicker here would silently swap the subject of the verdict
// from "your position" to "today's best new pick" without telling the user —
// confirmed as the wrong design with the architect before writing this file.
//
// Reuses, verified against the live repo before writing this (see session
// notes, item 5 build): buildOccSymbol (occSymbol.js), safeIV and
// scoreConviction (convictionScore.cjs), isOpeningWindow (scanLogic.js),
// getFundamentals (fundamentals.js). GEX/S/R inputs are deliberately omitted
// for v1 — confirmed both are optional/guarded in scoreConviction (default
// null, no crash), so this ships without them rather than adding
// getSRLevels' extra untracked Tradier call (already flagged as a rate-limit
// blind spot in scan.js) to a new, more-frequent cron before the core loop
// is proven.

const { buildOccSymbol } = require('./occSymbol')
const { safeIV, scoreConviction } = require('./convictionScore.cjs')
const { isOpeningWindow } = require('./scanLogic')
const { getFundamentals } = require('./fundamentals')

const TRADIER_MODE  = process.env.TRADIER_MODE  || 'production'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || ''
const TRADIER_BASE  = TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'

// getSingleQuote: fetches ONE symbol with greeks=true. Distinct from
// tradierClient.js's getQuote, which hardcodes greeks=false (correct for its
// only current callers, SPX/NDX index quotes, which have no greeks) — but
// wrong here, since we need delta on the option contract itself. Confirmed
// against Tradier's own documented /markets/quotes response shape (docs.
// tradier.com/docs/quotes, checked live during this session): a quote for
// an OCC option symbol returns "type":"option", "strike", "underlying", and
// a "greeks" object with delta/gamma/theta/vega WHEN greeks=true is passed —
// this had never been exercised in this codebase before (every existing
// getQuote call site only ever passed stock/index symbols), so this was
// verified against Tradier's docs rather than assumed from existing usage.
async function getSingleQuote(occSymbol, tracker) {
  const url = `${TRADIER_BASE}/markets/quotes?symbols=${occSymbol}&greeks=true`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } })
  if (tracker) {
    tracker.calls++
    tracker.statusCounts[r.status] = (tracker.statusCounts[r.status] || 0) + 1
  }
  if (!r.ok) return null
  let d
  try { d = await r.json() } catch { return null }
  const q = d?.quotes?.quote
  if (!q) return null
  // Same single-vs-array normalization already known from every other
  // Tradier endpoint in this codebase (batch quotes, option history,
  // timesales) — a single-symbol request returns a bare object, not an
  // array wrapping one object.
  return Array.isArray(q) ? q[0] : q
}

// Also need the UNDERLYING stock's quote (for chgPct, pos52, volRatio —
// all properties of the STOCK, not the option contract) plus SPX/NDX for
// the shared market-regime term scoreConviction expects. Three quotes, one
// batched Tradier call (comma-joined symbols) rather than three separate
// calls — same batching principle scan.js already uses for the 342-ticker
// universe, just at a much smaller scale here (one trade at a time).
async function getContextQuotes(ticker, tracker) {
  const symbols = `${ticker},SPX,NDX`
  const url = `${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(symbols)}&greeks=false`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } })
  if (tracker) {
    tracker.calls++
    tracker.statusCounts[r.status] = (tracker.statusCounts[r.status] || 0) + 1
  }
  if (!r.ok) return { stockQuote: null, spxQuote: null, ndxQuote: null }
  let d
  try { d = await r.json() } catch { return { stockQuote: null, spxQuote: null, ndxQuote: null } }
  let quotes = d?.quotes?.quote
  if (!quotes) return { stockQuote: null, spxQuote: null, ndxQuote: null }
  if (!Array.isArray(quotes)) quotes = [quotes]
  const find = sym => quotes.find(q => q.symbol === sym) || null
  return { stockQuote: find(ticker), spxQuote: find('SPX'), ndxQuote: find('NDX') }
}

// safeChgPctFromQuote: same logic shape as scanLogic.js's safeChgPct (not
// imported directly since that file doesn't export it under a stable name
// usable standalone here without pulling in scanTicker's other dependencies)
// — re-derives today's % change defensively, since change_percentage comes
// back as a real 0 both genuinely (flat stock) and falsely (frozen pre-
// market field, the original safeChgPct bug class this codebase already
// hit once). Falls back to computing from last vs prevclose directly.
function safeChgPctFromQuote(q) {
  if (!q) return { pct: 0, estimated: false }
  const reported = parseFloat(q.change_percentage)
  if (!isNaN(reported) && reported !== 0) return { pct: reported, estimated: false }
  const last = parseFloat(q.last || q.bid || 0)
  const prevclose = parseFloat(q.prevclose || 0)
  if (last && prevclose) {
    return { pct: ((last - prevclose) / prevclose) * 100, estimated: true }
  }
  return { pct: 0, estimated: false }
}

// checkVerdict: the main export. Given one open trade row, returns either
// a scored verdict or an explicit skip reason — NEVER a guessed/defaulted
// score. Skipping is the correct behavior for trades missing timeframe/
// target_price/stop_price (pre-dating this feature's migrations), per the
// session decision: an honest "not monitored" beats a silently-wrong number.
async function checkVerdict(trade, tracker) {
  if (!trade.timeframe) {
    return { skipped: true, reason: 'no_timeframe', tradeId: trade.id }
  }
  if (trade.target_price == null || trade.stop_price == null) {
    return { skipped: true, reason: 'no_target_stop', tradeId: trade.id }
  }

  const occSymbol = buildOccSymbol(trade.ticker, trade.option_type, trade.strike, trade.expiration)

  const [contractQuote, context] = await Promise.all([
    getSingleQuote(occSymbol, tracker),
    getContextQuotes(trade.ticker, tracker),
  ])

  if (!contractQuote) {
    return { skipped: true, reason: 'no_quote', tradeId: trade.id, occSymbol }
  }

  // Rounded to 2 decimals immediately — (bid+ask)/2 in JS float math can
  // produce artifacts like 3.8499999999999996 (confirmed live in
  // verdict_checks.current_mid). Rounding here, not just before insert,
  // matters because currentMid also feeds hitTarget/hitStop comparisons
  // and breakevenPrice math below — leaving it unrounded there risks a
  // boundary comparison being decided by a sub-cent float artifact rather
  // than the actual cent-denominated price a trader would see.
  const currentMid = Math.round(((parseFloat(contractQuote.bid || 0) + parseFloat(contractQuote.ask || 0)) / 2) * 100) / 100
  if (!currentMid || currentMid <= 0) {
    return { skipped: true, reason: 'no_usable_price', tradeId: trade.id, occSymbol }
  }

  const { stockQuote, spxQuote, ndxQuote } = context
  if (!stockQuote) {
    return { skipped: true, reason: 'no_underlying_quote', tradeId: trade.id }
  }

  const price = parseFloat(stockQuote.last || stockQuote.prevclose || 0)
  const chgInfo = safeChgPctFromQuote(stockQuote)
  const spxChg = safeChgPctFromQuote(spxQuote).pct
  const ndxChg = safeChgPctFromQuote(ndxQuote).pct

  const vol = parseFloat(stockQuote.volume || 0)
  const avgVol = parseFloat(stockQuote.average_volume || vol || 1)
  const volRatio = vol / (avgVol || 1)

  const hi52 = parseFloat(stockQuote.week_52_high || price)
  const lo52 = parseFloat(stockQuote.week_52_low || price)
  const pos52 = (price - lo52) / ((hi52 - lo52) || 1)

  const expiryDate = new Date(trade.expiration + 'T12:00:00')
  const dte = Math.round((expiryDate - new Date()) / (1000 * 60 * 60 * 24))

  // Breakeven distance, recomputed against CURRENT price — not the entry-
  // time be_req_pct already on the trade row, which answers a different
  // question ("how far was breakeven from the entry price") than what a
  // verdict check needs ("how far is breakeven from where the stock is
  // RIGHT NOW"). Direction-aware, same shape as scanLogic.js's own breakeven
  // math (checked during the audit, same session).
  const strike = parseFloat(trade.strike || 0)
  const isPut = (trade.option_type || '').toLowerCase().startsWith('p')
  const breakevenPrice = isPut ? strike - currentMid : strike + currentMid
  const breakevenReqPct = price ? Math.abs(((breakevenPrice / price) - 1) * 100) : null

  const fund = await getFundamentals(trade.ticker).catch(() => null)

  const currentScore = scoreConviction({
    chgPct: chgInfo.pct,
    chgPctEstimated: chgInfo.estimated,
    optType: isPut ? 'put' : 'call',
    iv: safeIV(contractQuote),
    delta: contractQuote.greeks?.delta || null,
    volRatio,
    strikeVolume: parseFloat(contractQuote.volume || 0),
    pos52,
    dte,
    spxChgToday: spxChg,
    ndxChgToday: ndxChg,
    breakevenReqPct,
    isMorningWindow: isOpeningWindow(),
    fundamentals: fund,
    tf: trade.timeframe,
    // gexSign/gexMagnitude01/srPosition/srDistPct intentionally omitted —
    // confirmed optional/guarded in scoreConviction, deferred to v2.
  })

  const entryScore = parseFloat(trade.conviction || 0)
  const scoreDelta = currentScore.score - entryScore   // negative = degraded

  // Per session decision: meaningful drop = 15+ points below entry score,
  // not an absolute floor and not a rolling average — entry score is each
  // trade's own baseline, so a 15-point drop means the SAME measuring stick
  // that said "95% conviction" at entry now says something materially
  // weaker, not just noisy day-to-day market chatter.
  const SCORE_DROP_THRESHOLD = 15
  const scoreDropFlag = scoreDelta <= -SCORE_DROP_THRESHOLD

  const hitTarget = currentMid >= parseFloat(trade.target_price)
  const hitStop = currentMid <= parseFloat(trade.stop_price)

  return {
    skipped: false,
    tradeId: trade.id,
    occSymbol,
    currentMid,
    currentScore: currentScore.score,
    entryScore,
    scoreDelta,
    flagged: hitTarget || hitStop || scoreDropFlag,
    flagReasons: [
      hitTarget && 'hit_target',
      hitStop && 'hit_stop',
      scoreDropFlag && 'score_dropped',
    ].filter(Boolean),
    checkedAt: new Date().toISOString(),
  }
}

module.exports = { checkVerdict, getSingleQuote, getContextQuotes, safeChgPctFromQuote }
