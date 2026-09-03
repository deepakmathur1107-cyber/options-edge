const finite = value => Number.isFinite(Number(value)) ? Number(value) : null

export function classifyMarketMover({
  symbol, optionType, quote, price, spxChange, ndxChange,
  expectedMovePct, breakevenRequiredPct, baseEligible,
}) {
  const p = finite(price)
  const open = finite(quote?.open)
  const high = finite(quote?.high)
  const low = finite(quote?.low)
  const spx = finite(spxChange)
  const ndx = finite(ndxChange)
  const expected = finite(expectedMovePct)
  const breakeven = finite(breakevenRequiredPct)
  const valueRatio = expected > 0 && breakeven != null ? breakeven / expected : null
  const bullish = optionType === 'call'
  const marketAligned = spx != null && ndx != null && (bullish ? spx > 0 && ndx > 0 : spx < 0 && ndx < 0)
  const dayRange = high != null && low != null && high > low ? high - low : null
  const sessionPosition = p != null && dayRange ? (p - low) / dayRange : null
  const aboveOpen = p != null && open != null ? p > open : null
  const nearExtreme = sessionPosition != null && (bullish ? sessionPosition >= 0.88 : sessionPosition <= 0.12)
  const directionHeld = aboveOpen != null && (bullish ? aboveOpen : !aboveOpen)
  const valueFavorable = valueRatio != null && valueRatio <= 0.70

  let setupType = 'NO VALID SETUP'
  let setupState = 'UNCONFIRMED'
  let triggerPrice = null
  let invalidationPrice = null

  if (marketAligned && directionHeld && nearExtreme) {
    setupType = 'MOMENTUM BREAKOUT'
    setupState = 'CONFIRMED'
    triggerPrice = bullish ? high : low
    invalidationPrice = open
  } else if (marketAligned && open != null && high != null && low != null && p != null) {
    setupType = 'PULLBACK & RECLAIM'
    setupState = 'WAITING_FOR_TRIGGER'
    // Session-open reclaim is deliberately observable from the quote feed.
    // Do not label this VWAP or a 15-minute close until intraday bars exist.
    triggerPrice = bullish ? Math.max(open, p * 1.0015) : Math.min(open, p * 0.9985)
    invalidationPrice = bullish ? low : high
  }

  let decision = 'NO_TRADE'
  if (setupState === 'CONFIRMED' && baseEligible && valueFavorable) decision = 'TAKE'
  else if (setupState === 'WAITING_FOR_TRIGGER' && baseEligible && valueFavorable) decision = 'TAKE_ON_TRIGGER'
  else if (setupType !== 'NO VALID SETUP' && !baseEligible) decision = 'WATCH'
  else if (setupType !== 'NO VALID SETUP' && valueRatio == null) decision = 'WATCH'

  const blockers = []
  if (!marketAligned) blockers.push('SPX and NDX are not directionally aligned')
  if (!baseEligible) blockers.push('one or more Quality gates failed')
  if (valueRatio == null) blockers.push('expected-move value is unavailable')
  else if (!valueFavorable) blockers.push(`breakeven needs ${(valueRatio * 100).toFixed(0)}% of expected move`)

  return {
    symbol,
    setupType,
    setupState,
    decision,
    triggerPrice,
    invalidationPrice,
    marketAligned,
    sessionPosition,
    expectedMovePct: expected,
    breakevenRequiredPct: breakeven,
    breakevenExpectedMoveRatio: valueRatio,
    valueFavorable,
    blockers,
    dataBasis: 'live session open/high/low + SPX/NDX alignment',
  }
}
