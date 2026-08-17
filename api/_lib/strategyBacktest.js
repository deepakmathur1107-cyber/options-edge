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

function modelObservation(signal, strategy, costs = DEFAULT_COSTS) {
  const entrySpot = Number(signal.underlying_price)
  const exitSpot = Number(signal.underlying_price_at_resolution)
  const iv = Number(signal.iv)
  const dte = Number(signal.dte_at_signal)
  const holdingMinutes = Number(signal.holding_minutes || 0)
  if (![entrySpot, exitSpot, iv, dte].every(Number.isFinite) || !(entrySpot > 0 && exitSpot > 0 && iv > 0 && dte > 0)) return null
  const entryValue = valueStrategy(strategy, entrySpot, dte / 365, iv)
  const exitDte = Math.max(0, dte - holdingMinutes / 1440)
  const exitValue = valueStrategy(strategy, exitSpot, exitDte / 365, iv)
  if (entryValue == null || exitValue == null) return null
  const debit = strategy.netDebit ?? entryValue
  const risk = strategy.maxLoss ?? Math.abs(debit)
  if (!(risk > 0)) return null
  const legs = strategy.legs.reduce((sum, leg) => sum + Math.abs(leg.quantity), 0)
  const slippage = (Math.abs(entryValue) + Math.abs(exitValue)) * costs.slippageBpsPerLegSide / 10000 * legs
  const fees = legs * costs.feePerContractSide * 2 / 100
  const pnl = (exitValue - entryValue) - slippage - fees
  return { strategy: strategy.id, returnOnRisk: pnl / risk, holdingMinutes, scannedAt: signal.scanned_at, exitAt: signal.resolved_at, ticker: signal.ticker }
}

function compareStrategies(signals, strategies, costs = DEFAULT_COSTS) {
  return strategies.map(strategy => {
    const observations = signals.map(signal => modelObservation(signal, strategy(signal), costs)).filter(Boolean)
    return { strategy: strategy.id || observations[0]?.strategy, metrics: summarizeReturns(observations), observations }
  })
}

module.exports = { DEFAULT_COSTS, valueStrategy, modelObservation, compareStrategies }
