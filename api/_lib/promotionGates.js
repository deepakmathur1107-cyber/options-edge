const DEFAULT_GATES = Object.freeze({
  minimumResolved: 300,
  minimumCohorts: 2,
  minimumExpectancyR: 0.05,
  minimumProfitFactor: 1.2,
  minimumWinRate: 0.40,
  maximumDrawdownR: 10,
  maximumTickerConcentration: 0.15,
  maximumSectorConcentration: 0.30,
})

function evaluatePromotion(rows, gates = DEFAULT_GATES) {
  const resolved = rows.filter(row =>
    ['WIN', 'LOSS', 'EXPIRED_PARTIAL', 'EXPIRED_FLAT'].includes(row.outcome) &&
    Number.isFinite(Number(row.realized_r_multiple))
  )
  const cohorts = new Set(resolved.map(row => row.experiment_cohort).filter(Boolean))
  const wins = resolved.filter(row => row.outcome === 'WIN').length
  const grossProfit = resolved.reduce((sum, row) => sum + Math.max(0, Number(row.realized_r_multiple)), 0)
  const grossLoss = Math.abs(resolved.reduce((sum, row) => sum + Math.min(0, Number(row.realized_r_multiple)), 0))
  const expectancyR = resolved.length
    ? resolved.reduce((sum, row) => sum + Number(row.realized_r_multiple), 0) / resolved.length
    : null
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null
  let cumulativeR = 0
  let peakR = 0
  let maximumDrawdownR = 0
  for (const row of [...resolved].sort((a, b) => new Date(a.scanned_at || 0) - new Date(b.scanned_at || 0))) {
    cumulativeR += Number(row.realized_r_multiple)
    peakR = Math.max(peakR, cumulativeR)
    maximumDrawdownR = Math.max(maximumDrawdownR, peakR - cumulativeR)
  }
  const cohortExpectancies = [...cohorts].map(cohort => {
    const cohortRows = resolved.filter(row => row.experiment_cohort === cohort)
    return {
      cohort,
      resolved: cohortRows.length,
      expectancyR: cohortRows.reduce((sum, row) => sum + Number(row.realized_r_multiple), 0) / cohortRows.length,
    }
  })

  const concentration = key => {
    if (!resolved.length) return null
    const counts = new Map()
    for (const row of resolved) {
      const value = row[key] || 'UNKNOWN'
      counts.set(value, (counts.get(value) || 0) + 1)
    }
    return Math.max(...counts.values()) / resolved.length
  }
  const tickerConcentration = concentration('ticker')
  const sectorConcentration = concentration('sector')
  const metrics = {
    resolved: resolved.length,
    cohorts: cohorts.size,
    winRate: resolved.length ? wins / resolved.length : null,
    expectancyR,
    profitFactor,
    maximumDrawdownR,
    cohortExpectancies,
    tickerConcentration,
    sectorConcentration,
  }
  const checks = {
    sampleSize: metrics.resolved >= gates.minimumResolved,
    cohortCount: metrics.cohorts >= gates.minimumCohorts,
    positiveExpectancy: metrics.expectancyR != null && metrics.expectancyR >= gates.minimumExpectancyR,
    profitFactor: metrics.profitFactor != null && metrics.profitFactor >= gates.minimumProfitFactor,
    winRate: metrics.winRate != null && metrics.winRate >= gates.minimumWinRate,
    maximumDrawdown: metrics.maximumDrawdownR <= gates.maximumDrawdownR,
    cohortStability: cohortExpectancies.length >= gates.minimumCohorts &&
      cohortExpectancies.every(cohort => cohort.resolved >= 30 && cohort.expectancyR >= gates.minimumExpectancyR),
    tickerConcentration: metrics.tickerConcentration != null &&
      metrics.tickerConcentration <= gates.maximumTickerConcentration,
    sectorConcentration: metrics.sectorConcentration != null &&
      metrics.sectorConcentration <= gates.maximumSectorConcentration,
  }
  return {
    eligible: Object.values(checks).every(Boolean),
    metrics,
    checks,
    gates,
    status: resolved.length ? 'MEASURING' : 'WAITING_FOR_FORWARD_RESOLUTIONS',
  }
}

module.exports = { DEFAULT_GATES, evaluatePromotion }
