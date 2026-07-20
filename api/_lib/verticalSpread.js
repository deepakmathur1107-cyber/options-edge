// api/_lib/verticalSpread.js
// Added 2026-07-19. Phase 1 of the re-architecture roadmap (see
// OptionsEdgeFlow_ReArchitecture_2026-07-19.md): SHADOW-ONLY computation of
// what a debit vertical spread would look like alongside the existing long-
// single selection, for Swing/LEAP/Deep LEAP timeframes.
//
// SHADOW MEANS SHADOW: this module is called ADDITIVELY. It never changes
// what's scored, displayed, or written as the live signal — it only computes
// a parallel "what if" structure that gets logged to its own columns for
// later expectancy comparison, once enough calendar time has passed to
// validate it out-of-sample (per the Team Assessment's data-adequacy gate).
// Do not wire this into scoreConviction, the displayed entry/target/stop, or
// any user-facing surface until that validation has actually happened.
//
// WHY VERTICALS: naked long options impose theta + IV-crush costs that
// demand the directional call be right fast and by a lot (this week's
// ~90%-wrong-direction-on-losses finding). A debit vertical (buy near-ATM,
// sell further OTM, same expiry) drastically reduces both — the short leg's
// decay/IV exposure offsets the long leg's — at the cost of capped upside.
// Smaller required move = higher probability of profit, mechanically, not
// through better signal-picking. This is an instrument change, not a
// scoring change, which is why it's the first phase: expected impact is
// evidence-light (the mechanism is well-understood options mechanics, not
// something that needs months of data to argue for) even though validating
// the ACTUAL expectancy still requires the same real-data discipline as
// everything else.
//
// WIDTH IS A PROVISIONAL DEFAULT, NOT A CALIBRATED VALUE. spreadWidthSteps
// below picks the short leg N `autoStep` increments beyond the long leg.
// Chosen to be a reasonable, typical vertical width — NOT backtested,
// NOT optimized. Revisit once shadow data accumulates.

const spreadWidthSteps = {
  'Swing (21–45 DTE)':       4,  // e.g. ~$10-20 wide on a $50-100 stock, step-dependent
  'LEAP (90–180 DTE)':       6,  // wider — bigger expected move over the longer hold
  'Deep LEAP (180–365 DTE)': 8,
}

// findLeg: nearest-strike matcher, mirrors scanLogic.js's own findLeg (kept
// local rather than importing to avoid a two-way require between these
// files — scanLogic.js already imports FROM this module in scan wiring).
function nearestStrike(arr, tgt) {
  return arr.length ? arr.reduce((a, b) => Math.abs(b.strike - tgt) < Math.abs(a.strike - tgt) ? b : a) : null
}

// buildVerticalSpread(chain, longLegTd, price, step, optType, tf)
// chain: full option chain for this expiry (same one already fetched for
//   the long-leg single-contract selection — no new Tradier call needed).
// longLegTd: the FORMATTED buildNakedResult() output for the already-
//   selected long leg — reuses its .primaryStrike/.bid/.ask directly rather
//   than requiring any change to buildNakedResult's return shape.
// Returns null if this timeframe isn't in scope, or if no valid short leg /
// pricing data is available (never throws — shadow computation failing
// silently must never affect the live path that called it).
//
// HISTORY: shipped 2026-07-19, initially came back null on 100% of rows.
// Diagnostic logging (since removed — root cause confirmed and fixed,
// verified against real production data at 96.6% population) found the
// short-leg selector had no liquidity check: far-OTM strikes are frequently
// illiquid (zero bid, wide stale ask), so mid=(0+wide_ask)/2 isn't a real
// price and was landing ABOVE the liquid long leg's mid — economically
// backwards. Fixed 2026-07-20 by requiring bid>0 on candidates.
//
// SECOND FIX (2026-07-20, same day, caught while reading post-fix logs):
// requiring bid>0 alone doesn't guarantee the picked strike is even on the
// correct SIDE of the long leg — e.g. a put's short leg must be BELOW the
// long strike (further OTM downward); if no liquid strike exists near the
// target, nearestStrike would happily return the nearest liquid strike
// regardless of side, occasionally producing a structurally backwards pair.
// These always got correctly rejected by the netDebit<=0 safety net (no bad
// data ever reached the database), but rejected for the wrong reason and
// missing otherwise-valid spreads. Now filtered to the correct side FIRST.
function buildVerticalSpread(chain, longLegTd, price, step, optType, tf) {
  const widthSteps = spreadWidthSteps[tf]
  if (!widthSteps) return null // Quick — out of scope for Phase 1, not a bug
  if (!longLegTd || !longLegTd.primaryStrike) return null

  const longStrike = longLegTd.primaryStrike
  const side = chain.filter(o => o.option_type === optType)
  if (side.length < 2) return null

  const width = widthSteps * step
  const shortTarget = optType === 'call' ? longStrike + width : longStrike - width
  // Liquidity floor (bid>0) AND correct directional side — calls: strike
  // must be ABOVE longStrike; puts: strike must be BELOW longStrike. Both
  // conditions are the actual fix; neither alone is sufficient (see HISTORY
  // above for what happens without each).
  const candidates = side.filter(o =>
    parseFloat(o.bid || 0) > 0 &&
    (optType === 'call' ? o.strike > longStrike : o.strike < longStrike)
  )
  if (!candidates.length) return null
  const shortLeg = nearestStrike(candidates, shortTarget)
  if (!shortLeg) return null

  const longMid = longLegTd.mid
  const shortBid = Math.max(0, parseFloat(shortLeg.bid || 0))
  const shortAsk = Math.max(0, parseFloat(shortLeg.ask || 0))
  const shortMid = Math.round(((shortBid + shortAsk) / 2) * 100) / 100
  if (shortMid < 0) return null // defensive; Math.max(0,...) above makes this unreachable in practice

  const netDebit = Math.round((longMid - shortMid) * 100) / 100
  if (netDebit <= 0) return null // remaining safety net for residual bad-quote cases (e.g. bid>0 but still an unrealistically wide/stale market)

  const actualWidth = Math.abs(shortLeg.strike - longStrike)
  const maxProfit = Math.round((actualWidth - netDebit) * 100) / 100
  const maxLoss = netDebit
  if (maxProfit <= 0) return null // width too narrow relative to debit to make economic sense

  const breakevenPrice = optType === 'call'
    ? longStrike + netDebit
    : longStrike - netDebit
  const breakevenReqPct = ((breakevenPrice / price) - 1) * 100 // signed: positive = stock must rise, negative = must fall

  return {
    long_strike: longStrike,
    short_strike: shortLeg.strike,
    spread_width: actualWidth,
    net_debit: netDebit,
    max_profit: maxProfit,
    max_loss: maxLoss,
    breakeven_price: Math.round(breakevenPrice * 100) / 100,
    breakeven_req_pct: Math.round(breakevenReqPct * 100) / 100,
    // Expressed as % of debit risked, for expectancy comparison against the
    // single-leg's %-of-premium target/stop — spreads have a fundamentally
    // different risk unit (fixed $ debit vs. %-of-premium), so this
    // normalization is what makes the later expectancy comparison fair.
    max_profit_pct_of_debit: Math.round((maxProfit / netDebit) * 10000) / 100,
  }
}

module.exports = { buildVerticalSpread, spreadWidthSteps }
