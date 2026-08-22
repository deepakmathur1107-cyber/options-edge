const { blackScholes } = require('./optionsModel')
const { summarizeReturns } = require('./oeProfitability')

const DEFAULT_COSTS = Object.freeze({ slippageBpsPerLegSide: 25, feePerContractSide: 0.65 })

function legPrice(leg, spot, years, iv) {
  return blackScholes({ spot, strike: leg.strike, years: Math.max(years, 1 / 3650), volatility: iv, optionType: leg.optionType })?.price
}

function valueStrategy(strategy, spot, years, iv) {
  let value = 0
  for (const leg of strategy.legs) {
    const price = legPrice(leg, spot, years, iv)
    if (price == null) return null
    value += leg.quantity * price
  }
  return value
}

function strategyMark(strategy, spot, years, iv) {
  let signed = 0
  let absolute = 0
  for (const leg of strategy.legs) {
    const price = legPrice(leg, spot, years, iv)
    if (price == null) return null
    signed += leg.quantity * price
    absolute += Math.abs(leg.quantity) * price
  }
  return { signed, absolute }
}

function modeledMaxRisk(strategy, entryValue) {
  const stated = Number(strategy.maxLoss)
  if (Number.isFinite(stated) && stated > 0) return stated
  if (strategy.family === 'DEFINED_RISK_CREDIT') {
    const width = Number(strategy.width)
    const credit = Math.max(0, -entryValue)
    return Number.isFinite(width) && width > credit ? width - credit : null
  }
  return entryValue > 0 ? entryValue : null
}

function modelObservation(signal, strategy, costs = DEFAULT_COSTS) {
  const entrySpot = Number(signal.underlying_price)
  const exitSpot = Number(signal.underlying_price_at_resolution)
  const iv = Number(signal.iv)
  const dte = Number(signal.dte_at_signal)
  const holdingMinutes = Number(signal.holding_minutes || 0)
  if (![entrySpot, exitSpot, iv, dte].every(Number.isFinite) || !(entrySpot > 0 && exitSpot > 0 && iv > 0 && dte > 0)) return null
  const entryMark = strategyMark(strategy, entrySpot, dte / 365, iv)
  const exitDte = Math.max(0, dte - holdingMinutes / 1440)
  const exitMark = strategyMark(strategy, exitSpot, exitDte / 365, iv)
  if (!entryMark || !exitMark) return null
  const entryValue = entryMark.signed
  const exitValue = exitMark.signed
  const risk = modeledMaxRisk(strategy, entryValue)
  if (!(risk > 0)) return null
  const legs = strategy.legs.reduce((sum, leg) => sum + Math.abs(leg.quantity), 0)
  const slippage = (entryMark.absolute + exitMark.absolute) * costs.slippageBpsPerLegSide / 10000
  const fees = legs * costs.feePerContractSide * 2 / 100
  const pnl = (exitValue - entryValue) - slippage - fees
  return { strategy: strategy.id, returnOnRisk: pnl / risk, holdingMinutes, scannedAt: signal.scanned_at, exitAt: signal.resolved_at, ticker: signal.ticker, evidenceType: 'MODELED_CONSTANT_IV' }
}

function strikeStep(price) {
  return price < 25 ? 0.5 : price < 50 ? 1 : price < 100 ? 2 : price < 250 ? 5 : price < 500 ? 10 : price < 1000 ? 20 : 50
}

function buildHistoricalStrategies(signal) {
  const direction = String(signal.option_type || '').toLowerCase()
  const spot = Number(signal.underlying_price)
  const primaryStrike = Number(signal.primary_strike)
  if (!['call', 'put'].includes(direction) || !(spot > 0) || !(primaryStrike > 0)) return []
  const step = strikeStep(spot)
  const widthSteps = String(signal.timeframe || '').startsWith('Quick') ? 2
    : String(signal.timeframe || '').startsWith('Swing') ? 4 : 6
  const width = step * widthSteps
  const bullish = direction === 'call'
  const debitShortStrike = primaryStrike + (bullish ? width : -width)
  const creditShortStrike = primaryStrike + (bullish ? -step : step)
  const creditLongStrike = creditShortStrike + (bullish ? -width : width)
  return [
    { id: bullish ? 'LONG_CALL' : 'LONG_PUT', family: 'LONG_OPTION', legs: [{ optionType: direction, strike: primaryStrike, quantity: 1 }] },
    { id: bullish ? 'BULL_CALL_DEBIT' : 'BEAR_PUT_DEBIT', family: 'DEFINED_RISK_DEBIT', width, legs: [{ optionType: direction, strike: primaryStrike, quantity: 1 }, { optionType: direction, strike: debitShortStrike, quantity: -1 }] },
    { id: bullish ? 'BULL_PUT_CREDIT' : 'BEAR_CALL_CREDIT', family: 'DEFINED_RISK_CREDIT', width, legs: [{ optionType: bullish ? 'put' : 'call', strike: creditShortStrike, quantity: -1 }, { optionType: bullish ? 'put' : 'call', strike: creditLongStrike, quantity: 1 }] },
  ]
}

function compareHistoricalSignals(signals, costs = DEFAULT_COSTS) {
  const groups = new Map()
  for (const signal of signals) {
    for (const strategy of buildHistoricalStrategies(signal)) {
      const observation = modelObservation(signal, strategy, costs)
      if (!observation) continue
      if (!groups.has(strategy.id)) groups.set(strategy.id, [])
      groups.get(strategy.id).push(observation)
    }
  }
  return [...groups.entries()].map(([strategy, observations]) => ({ strategy, metrics: summarizeReturns(observations), observations }))
}

function compareStrategies(signals, strategies, costs = DEFAULT_COSTS) {
  return strategies.map(strategy => {
    const observations = signals.map(signal => modelObservation(signal, strategy(signal), costs)).filter(Boolean)
    return { strategy: strategy.id || observations[0]?.strategy, metrics: summarizeReturns(observations), observations }
  })
}

module.exports = { DEFAULT_COSTS, valueStrategy, modelObservation, compareStrategies, buildHistoricalStrategies, compareHistoricalSignals }
