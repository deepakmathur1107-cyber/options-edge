// api/_lib/creditSpreadShadow.js
//
// swing_credit_spread_managed_v1 — SHADOW ONLY (registered 2026-10-18).
// Pure functions for building and managing defined-risk credit spreads.
// No I/O lives here; the open/manage crons do the fetching and writing.
//
// Why this exists: forward data (Jul 27 – Oct 16 2026) showed every long-
// option cohort losing money, and the existing credit candidates in
// strategyCandidates.js (directional_structures_v1) are mis-specified for a
// fair test: 0.25-delta short, wide wing, legs allowed up to 40% spread,
// average credit/width only 0.10 at natural. This module builds the spread
// the way the hypothesis actually describes it and manages it by its own
// rules instead of the long option's exit time.
//
// Every number below is a pre-registered rule, not a tuned value. Do not
// change them while the experiment is running; register a v2 instead.

const RULES = Object.freeze({
  strategyVersion: 'swing_credit_spread_managed_v1',
  measurementVersion: 'credit_mgmt_v1',
  minDte: 30,
  maxDte: 45,
  targetDte: 38,
  targetShortDelta: 0.30,
  minShortDelta: 0.20,
  maxShortDelta: 0.40,
  maxWidthSteps: 4,
  // Cost guards (replace the spec's 0.25 credit/width-at-natural floor,
  // which is near-unattainable with a 0.30-delta short: mid credit/width
  // is roughly the short leg's delta before any crossing cost).
  minCreditToWidth: 0.15,          // reject absurdly wide wings
  maxCrossingCostFraction: 0.25,   // (mid credit - natural credit) / mid credit
  minCreditPerShare: 0.25,         // keeps $2.60 round-trip fees <= ~10% of credit
  maxLegSpreadPct: { A_INDEX: 5, B_STOCK: 10, C_SIGNAL: 10 },
  takeProfitFractionOfCredit: 0.50,
  stopCostMultipleOfCredit: 3.0, // cost to close >= 3x credit means loss = 2x credit
  timeExitDte: 21,
  feePerContractSide: 0.65,
})

function num(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function daysBetween(fromDate, toDate) {
  const from = new Date(`${fromDate}T12:00:00Z`).getTime()
  const to = new Date(`${toDate}T12:00:00Z`).getTime()
  return Math.round((to - from) / 86_400_000)
}

// Monday of the ISO week containing dateStr ('YYYY-MM-DD'). Used for the
// one-position-per-arm-per-ticker-per-week rule (DB-enforced unique key).
function isoWeekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const offset = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}

// Bid-ask spread as percent of mid. Null when the quote is not two-sided.
function legSpreadPct(leg) {
  const bid = num(leg?.bid)
  const ask = num(leg?.ask)
  if (bid == null || ask == null || !(bid > 0) || !(ask >= bid)) return null
  return ((ask - bid) / ((ask + bid) / 2)) * 100
}

// Expiry closest to targetDte inside [minDte, maxDte]. Ties go to the later
// expiry (more premium, same rule every time).
function pickExpiry(expiries, today, rules = RULES) {
  let best = null
  for (const expiry of expiries || []) {
    const dte = daysBetween(today, expiry)
    if (dte < rules.minDte || dte > rules.maxDte) continue
    const distance = Math.abs(dte - rules.targetDte)
    if (!best || distance < best.distance || (distance === best.distance && dte > best.dte)) {
      best = { expiry, dte, distance }
    }
  }
  return best ? { expiry: best.expiry, dte: best.dte } : null
}

// Direction per arm. Returns 'BULL_PUT', 'BEAR_CALL', or null (no trade).
//   A_INDEX: above 200-day SMA -> bull put, below -> bear call.
//   B_STOCK: bullish long-term trend only -> bull put.
//   C_SIGNAL: follows the live signal's direction (control arm).
function pickSide({ arm, price, sma200, trend, signalOptionType }) {
  if (arm === 'A_INDEX') {
    const p = num(price)
    const s = num(sma200)
    if (p == null || s == null) return null
    return p > s ? 'BULL_PUT' : p < s ? 'BEAR_CALL' : null
  }
  if (arm === 'B_STOCK') return trend === 'bullish' ? 'BULL_PUT' : null
  if (arm === 'C_SIGNAL') {
    const type = String(signalOptionType || '').toLowerCase()
    return type === 'call' ? 'BULL_PUT' : type === 'put' ? 'BEAR_CALL' : null
  }
  return null
}

// buildCreditSpread — selects the short leg nearest the target delta among
// out-of-the-money, two-sided, tight-spread contracts, then the narrowest
// protective long leg (1..maxWidthSteps listed strikes further out) whose
// natural credit is at least minCreditToWidth of the width.
// Returns { ok: true, spread } or { ok: false, reason }.
function buildCreditSpread({ chain, price, side, arm }, rules = RULES) {
  const underlying = num(price)
  if (!(underlying > 0)) return { ok: false, reason: 'NO_UNDERLYING_PRICE' }
  if (side !== 'BULL_PUT' && side !== 'BEAR_CALL') return { ok: false, reason: 'NO_SIDE' }
  const optionType = side === 'BULL_PUT' ? 'put' : 'call'
  const maxLegSpread = rules.maxLegSpreadPct[arm] ?? 10

  const sameType = (chain || [])
    .filter(leg => leg?.option_type === optionType && num(leg.strike) != null)
    .sort((a, b) => num(a.strike) - num(b.strike))
  if (sameType.length < 2) return { ok: false, reason: 'CHAIN_TOO_SMALL' }

  const otm = sameType.filter(leg => side === 'BULL_PUT'
    ? num(leg.strike) < underlying
    : num(leg.strike) > underlying)

  const shortCandidates = otm.filter(leg => {
    const delta = Math.abs(num(leg.greeks?.delta) ?? NaN)
    const spread = legSpreadPct(leg)
    return Number.isFinite(delta) &&
      delta >= rules.minShortDelta && delta <= rules.maxShortDelta &&
      spread != null && spread <= maxLegSpread
  })
  if (!shortCandidates.length) return { ok: false, reason: 'NO_LIQUID_SHORT_NEAR_TARGET_DELTA' }

  const shortLeg = shortCandidates.reduce((best, leg) => {
    const d = Math.abs(Math.abs(num(leg.greeks.delta)) - rules.targetShortDelta)
    const bd = Math.abs(Math.abs(num(best.greeks.delta)) - rules.targetShortDelta)
    return d < bd ? leg : best
  })
  const shortStrike = num(shortLeg.strike)
  const shortBid = num(shortLeg.bid)
  const shortAsk = num(shortLeg.ask)

  // Listed strikes further OTM than the short, nearest first.
  const further = sameType
    .filter(leg => side === 'BULL_PUT' ? num(leg.strike) < shortStrike : num(leg.strike) > shortStrike)
    .sort((a, b) => Math.abs(num(a.strike) - shortStrike) - Math.abs(num(b.strike) - shortStrike))
    .slice(0, rules.maxWidthSteps)

  let lastReason = 'NO_PROTECTIVE_LEG'
  for (const longLeg of further) {
    const longAsk = num(longLeg.ask)
    const longBid = num(longLeg.bid)
    const spread = legSpreadPct(longLeg)
    if (!(longAsk > 0) || spread == null || spread > maxLegSpread) {
      lastReason = 'PROTECTIVE_LEG_ILLIQUID'
      continue
    }
    const width = Math.abs(shortStrike - num(longLeg.strike))
    const creditNatural = shortBid - longAsk
    const creditMid = (shortBid + shortAsk) / 2 - (longBid + longAsk) / 2
    if (!(creditNatural >= rules.minCreditPerShare)) { lastReason = 'CREDIT_TOO_SMALL'; continue }
    if (!(creditMid > 0) || (creditMid - creditNatural) / creditMid > rules.maxCrossingCostFraction) {
      lastReason = 'CROSSING_COST_TOO_HIGH'
      continue
    }
    const creditToWidth = creditNatural / width
    if (creditToWidth < rules.minCreditToWidth) { lastReason = 'CREDIT_TO_WIDTH_BELOW_MIN'; continue }
    if (!(width - creditNatural > 0)) { lastReason = 'NO_DEFINED_RISK'; continue }
    return {
      ok: true,
      spread: {
        side,
        short_strike: shortStrike,
        long_strike: num(longLeg.strike),
        width: round(width),
        short_symbol: shortLeg.symbol || null,
        long_symbol: longLeg.symbol || null,
        short_delta_at_entry: round(num(shortLeg.greeks.delta)),
        short_iv_at_entry: round(num(shortLeg.greeks?.mid_iv ?? shortLeg.greeks?.smv_vol)),
        underlying_at_entry: underlying,
        entry_credit_natural: round(creditNatural),
        entry_credit_mid: round(creditMid),
        credit_to_width: round(creditToWidth),
        max_loss: round(width - creditNatural),
      },
    }
  }
  return { ok: false, reason: lastReason }
}

// Value of the spread at expiry from the underlying close, per share.
// This is what it costs to close (or what is lost at settlement).
function settlementDebit(position, underlying) {
  const s = num(underlying)
  if (s == null) return null
  const shortStrike = num(position.short_strike)
  const width = num(position.width)
  const intrinsic = position.side === 'BULL_PUT'
    ? Math.max(0, shortStrike - s)
    : Math.max(0, s - shortStrike)
  return round(Math.min(width, intrinsic))
}

// Natural cost to close today: buy back the short at its ask, sell the long
// at its bid. Clamped to [0, width]. Null when the short leg has no ask.
function naturalCloseDebit(position, mark) {
  const shortAsk = num(mark?.short_ask)
  if (shortAsk == null || shortAsk < 0) return null
  const longBid = Math.max(0, num(mark?.long_bid) ?? 0)
  return round(Math.min(num(position.width), Math.max(0, shortAsk - longBid)))
}

// evaluateExit — applied once per trading day near the close.
// Order: expiry settlement, stop, take profit, time exit.
// Returns { action: 'HOLD' | 'CLOSE' | 'NO_DATA', reason?, exitDebit? }.
function evaluateExit(position, mark, today, rules = RULES) {
  const dte = daysBetween(today, String(position.expiry).slice(0, 10))
  const credit = num(position.entry_credit_natural)

  if (dte <= 0) {
    const debit = settlementDebit(position, mark?.underlying)
    if (debit == null) return { action: 'NO_DATA', reason: 'EXPIRY_NO_UNDERLYING' }
    return { action: 'CLOSE', reason: 'EXPIRY', exitDebit: debit }
  }

  const debit = naturalCloseDebit(position, mark)
  if (debit == null) return { action: 'NO_DATA', reason: 'NO_SHORT_LEG_QUOTE' }

  if (debit >= credit * rules.stopCostMultipleOfCredit) return { action: 'CLOSE', reason: 'STOP', exitDebit: debit }
  if (debit <= credit * rules.takeProfitFractionOfCredit) return { action: 'CLOSE', reason: 'TAKE_PROFIT', exitDebit: debit }
  if (dte <= rules.timeExitDte) return { action: 'CLOSE', reason: 'TIME_21DTE', exitDebit: debit }
  return { action: 'HOLD', currentDebit: debit, dte }
}

// P&L for one spread (100 shares per contract). Entry fees always apply;
// exit fees apply unless both legs expired worthless.
function computePnl(position, exitDebit, exitReason, rules = RULES) {
  const credit = num(position.entry_credit_natural)
  const maxLoss = num(position.max_loss)
  const debit = num(exitDebit)
  if (credit == null || maxLoss == null || debit == null) return null
  const entryFees = 2 * rules.feePerContractSide
  const exitFees = exitReason === 'EXPIRY' && debit === 0 ? 0 : 2 * rules.feePerContractSide
  const fees = entryFees + exitFees
  const netPnl = (credit - debit) * 100 - fees
  const capital = maxLoss * 100 + entryFees
  return {
    fees_dollars: round(fees, 2),
    net_pnl_dollars: round(netPnl, 2),
    return_on_risk: round(netPnl / capital),
  }
}

// Earnings between today and expiry (inclusive) disqualifies single stocks.
function hasEarningsBeforeExpiry(earningsDate, today, expiry) {
  if (!earningsDate) return false
  const e = String(earningsDate).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return false
  return e >= today && e <= expiry
}

module.exports = {
  RULES,
  isoWeekStart,
  legSpreadPct,
  pickExpiry,
  pickSide,
  buildCreditSpread,
  settlementDebit,
  naturalCloseDebit,
  evaluateExit,
  computePnl,
  hasEarningsBeforeExpiry,
  daysBetween,
}
