const CANDIDATE_VERSION = 'directional_structures_v1'

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function quote(leg) {
  const bid = number(leg?.bid)
  const ask = number(leg?.ask)
  if (bid == null || ask == null || bid < 0 || ask <= 0 || ask < bid) return null
  return { bid, ask, mid: (bid + ask) / 2, spreadPct: ((ask - bid) / ((ask + bid) / 2)) * 100 }
}

function legRecord(leg, quantity) {
  const market = quote(leg)
  if (!market) return null
  return {
    optionType: leg.option_type,
    strike: number(leg.strike),
    quantity,
    bid: market.bid,
    ask: market.ask,
    mid: market.mid,
    delta: number(leg.greeks?.delta),
    volume: number(leg.volume) || 0,
    openInterest: number(leg.open_interest) || 0,
  }
}

function liquid(leg) {
  const market = quote(leg)
  return market && market.bid > 0 && market.spreadPct <= 40
}

function nearestByStrike(legs, target) {
  return legs.length ? legs.reduce((a, b) => Math.abs(Number(b.strike) - target) < Math.abs(Number(a.strike) - target) ? b : a) : null
}

function nearestByDelta(legs, target) {
  const withDelta = legs.filter(leg => Number.isFinite(Math.abs(number(leg.greeks?.delta))))
  return withDelta.length
    ? withDelta.reduce((a, b) => Math.abs(Math.abs(Number(b.greeks.delta)) - target) < Math.abs(Math.abs(Number(a.greeks.delta)) - target) ? b : a)
    : null
}

function buildCreditSpread(chain, price, step, direction, widthSteps = 4) {
  const bullish = direction === 'call'
  const optionType = bullish ? 'put' : 'call'
  const side = chain.filter(leg => leg.option_type === optionType && liquid(leg))
  if (side.length < 2) return null
  const directional = side.filter(leg => bullish ? Number(leg.strike) < price : Number(leg.strike) > price)
  const shortLeg = nearestByDelta(directional, 0.25) || nearestByStrike(directional, bullish ? price - step : price + step)
  if (!shortLeg) return null
  const width = step * widthSteps
  const longTarget = bullish ? Number(shortLeg.strike) - width : Number(shortLeg.strike) + width
  const protective = side.filter(leg => bullish ? Number(leg.strike) < Number(shortLeg.strike) : Number(leg.strike) > Number(shortLeg.strike))
  const longLeg = nearestByStrike(protective, longTarget)
  if (!longLeg) return null
  const shortQuote = quote(shortLeg); const longQuote = quote(longLeg)
  const netCredit = shortQuote.bid - longQuote.ask
  const actualWidth = Math.abs(Number(shortLeg.strike) - Number(longLeg.strike))
  if (!(netCredit > 0) || !(actualWidth > netCredit)) return null
  const shortRecord = legRecord(shortLeg, -1); const longRecord = legRecord(longLeg, 1)
  if (!shortRecord || !longRecord) return null
  return {
    id: bullish ? 'BULL_PUT_CREDIT' : 'BEAR_CALL_CREDIT',
    family: 'DEFINED_RISK_CREDIT',
    legs: [shortRecord, longRecord],
    entryCredit: netCredit,
    maxProfit: netCredit,
    maxLoss: actualWidth - netCredit,
    breakeven: bullish ? Number(shortLeg.strike) - netCredit : Number(shortLeg.strike) + netCredit,
    width: actualWidth,
  }
}

function buildStrategyCandidates({ chain, selected, price, step, direction, timeframe }) {
  const longMarket = selected ? { bid: number(selected.bid), ask: number(selected.ask), mid: number(selected.mid) } : null
  const longCandidate = selected && longMarket?.mid > 0 ? {
    id: direction === 'call' ? 'LONG_CALL' : 'LONG_PUT',
    family: 'LONG_OPTION',
    legs: [{ optionType: direction, strike: number(selected.primaryStrike), quantity: 1, ...longMarket }],
    entryDebit: longMarket.ask,
    maxLoss: longMarket.ask,
  } : null
  const debit = selected?.shadowSpread ? {
    id: direction === 'call' ? 'BULL_CALL_DEBIT' : 'BEAR_PUT_DEBIT',
    family: 'DEFINED_RISK_DEBIT',
    legs: [
      { optionType: direction, strike: selected.shadowSpread.long_strike, quantity: 1 },
      { optionType: direction, strike: selected.shadowSpread.short_strike, quantity: -1 },
    ],
    entryDebit: selected.shadowSpread.net_debit,
    maxProfit: selected.shadowSpread.max_profit,
    maxLoss: selected.shadowSpread.max_loss,
    breakeven: selected.shadowSpread.breakeven_price,
    width: selected.shadowSpread.spread_width,
  } : null
  const widthSteps = timeframe?.startsWith('Quick') ? 2 : timeframe?.startsWith('Swing') ? 4 : 6
  const credit = buildCreditSpread(chain, price, step, direction, widthSteps)
  const candidates = [longCandidate, debit, credit].filter(Boolean)
  return {
    version: CANDIDATE_VERSION,
    generatedAt: new Date().toISOString(),
    sameSignalTiming: true,
    shadowOnly: true,
    candidates,
    coverage: {
      longOption: !!longCandidate,
      debitSpread: !!debit,
      creditSpread: !!credit,
      completeComparison: !!longCandidate && !!debit && !!credit,
    },
  }
}

module.exports = { CANDIDATE_VERSION, buildCreditSpread, buildStrategyCandidates }
