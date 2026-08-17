const DEFAULT_VALIDATION_GATES = Object.freeze({
  minimumOutOfSampleTrades: 300,
  minimumCohorts: 2,
  minimumExpectancy: 0,
  minimumProfitFactor: 1.2,
  maximumDrawdownPct: 25,
  minimumSharpe: 0,
})

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function summarizeReturns(observations = []) {
  const rows = observations
    .map(row => ({ ...row, returnOnRisk: finite(row.returnOnRisk) }))
    .filter(row => row.returnOnRisk != null)
    .sort((a, b) => new Date(a.exitAt || a.scannedAt || 0) - new Date(b.exitAt || b.scannedAt || 0))
  const returns = rows.map(row => row.returnOnRisk)
  const wins = returns.filter(value => value > 0)
  const losses = returns.filter(value => value < 0)
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
    : null
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  for (const value of returns) {
    equity *= Math.max(0, 1 + value)
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  const grossProfit = wins.reduce((sum, value) => sum + value, 0)
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0))
  const holding = rows.map(row => finite(row.holdingMinutes)).filter(value => value != null)
  return {
    sampleSize: returns.length,
    winRate: returns.length ? wins.length / returns.length : null,
    expectancy: mean,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    averageWin: wins.length ? grossProfit / wins.length : null,
    averageLoss: losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : null,
    maxDrawdown,
    returnOnRisk: mean,
    sharpe: variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(252) : null,
    averageHoldingMinutes: holding.length ? holding.reduce((sum, value) => sum + value, 0) / holding.length : null,
  }
}

function evaluateProfitabilityGate(validation, gates = DEFAULT_VALIDATION_GATES) {
  const metrics = validation?.outOfSample || summarizeReturns([])
  const cohorts = finite(validation?.cohorts) || 0
  const checks = {
    outOfSample: validation?.partition === 'OUT_OF_SAMPLE',
    sampleSize: metrics.sampleSize >= gates.minimumOutOfSampleTrades,
    cohorts: cohorts >= gates.minimumCohorts,
    positiveExpectancy: metrics.expectancy != null && metrics.expectancy > gates.minimumExpectancy,
    profitFactor: metrics.profitFactor != null && metrics.profitFactor >= gates.minimumProfitFactor,
    drawdown: metrics.maxDrawdown != null && metrics.maxDrawdown <= gates.maximumDrawdownPct / 100,
    sharpe: metrics.sharpe != null && metrics.sharpe > gates.minimumSharpe,
    afterCosts: validation?.costModelApplied === true,
    sameSignalTiming: validation?.sameSignalTiming === true,
  }
  return {
    decision: Object.values(checks).every(Boolean) ? 'PUBLISH' : 'NO_TRADE',
    publish: Object.values(checks).every(Boolean),
    checks,
    metrics,
    gates,
  }
}

function calculateOEProfitabilityScore({ validation, liquidity = {}, quoteQuality = {} }) {
  const gate = evaluateProfitabilityGate(validation)
  const metrics = gate.metrics
  const sample = Math.min(1, (metrics.sampleSize || 0) / DEFAULT_VALIDATION_GATES.minimumOutOfSampleTrades)
  const expectancy = Math.max(0, Math.min(1, (metrics.expectancy || 0) / 0.25))
  const profitFactor = Math.max(0, Math.min(1, ((metrics.profitFactor || 0) - 1) / 1))
  const drawdown = metrics.maxDrawdown == null ? 0 : Math.max(0, 1 - metrics.maxDrawdown / 0.25)
  const spread = finite(liquidity.spreadPct)
  const liquidityScore = spread == null ? 0 : Math.max(0, 1 - spread / 20)
  const quoteScore = quoteQuality.live === true && quoteQuality.complete === true ? 1 : 0
  const raw = 100 * (0.25 * sample + 0.25 * expectancy + 0.20 * profitFactor + 0.15 * drawdown + 0.10 * liquidityScore + 0.05 * quoteScore)
  return { score: Math.round(raw), decision: gate.decision, gate }
}

module.exports = { DEFAULT_VALIDATION_GATES, summarizeReturns, evaluateProfitabilityGate, calculateOEProfitabilityScore }
