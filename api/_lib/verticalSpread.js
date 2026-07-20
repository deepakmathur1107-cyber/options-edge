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
// TEMPORARY DIAGNOSTIC LOGGING (added 2026-07-20) — shadow_vertical_spread
// came back null on 100% of Swing/LEAP/Deep LEAP rows in production despite
// tracing correctly against synthetic test data. Every early-return branch
// below now logs which one fired, so the next real scan reveals the actual
// cause instead of more guessing. REMOVE once root-caused and fixed — this
// is deliberately noisy for a live cron and shouldn't stay long-term.
function buildVerticalSpread(chain, longLegTd, price, step, optType, tf) {
  const widthSteps = spreadWidthSteps[tf]
  if (!widthSteps) return null // Quick — expected, not a bug
  if (!longLegTd || !longLegTd.primaryStrike) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: no longLegTd/primaryStrike`)
    return null
  }

  const longStrike = longLegTd.primaryStrike
  const side = chain.filter(o => o.option_type === optType)
  if (side.length < 2) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: side.length=${side.length} (need >=2), chain.length=${chain.length}`)
    return null
  }

  const width = widthSteps * step
  const shortTarget = optType === 'call' ? longStrike + width : longStrike - width
  const candidates = side.filter(o => o.strike !== longStrike)
  if (!candidates.length) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: no candidates after excluding longStrike=${longStrike}, side.length=${side.length}, sample strikes=${side.slice(0,5).map(o=>o.strike).join(',')}`)
    return null
  }
  const shortLeg = nearestStrike(candidates, shortTarget)
  if (!shortLeg) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: nearestStrike returned null, shortTarget=${shortTarget}, candidates.length=${candidates.length}`)
    return null
  }

  const longMid = longLegTd.mid
  const shortBid = Math.max(0, parseFloat(shortLeg.bid || 0))
  const shortAsk = Math.max(0, parseFloat(shortLeg.ask || 0))
  const shortMid = Math.round(((shortBid + shortAsk) / 2) * 100) / 100
  if (shortMid < 0) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: shortMid<0 (should be impossible), shortLeg.bid=${shortLeg.bid}, shortLeg.ask=${shortLeg.ask}`)
    return null
  }

  const netDebit = Math.round((longMid - shortMid) * 100) / 100
  if (netDebit <= 0) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: netDebit<=0 (${netDebit}), longStrike=${longStrike} longMid=${longMid}, shortStrike=${shortLeg.strike} shortMid=${shortMid}, shortTarget=${shortTarget}, width=${width}, step=${step}`)
    return null
  }

  const actualWidth = Math.abs(shortLeg.strike - longStrike)
  const maxProfit = Math.round((actualWidth - netDebit) * 100) / 100
  const maxLoss = netDebit
  if (maxProfit <= 0) {
    console.warn(`[verticalSpread DIAG] ${tf} ${optType}: maxProfit<=0 (${maxProfit}), actualWidth=${actualWidth}, netDebit=${netDebit}, longStrike=${longStrike}, shortStrike=${shortLeg.strike}`)
    return null
  }

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
