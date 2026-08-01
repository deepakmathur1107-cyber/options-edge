const test = require('node:test')
const assert = require('node:assert/strict')
const { _test } = require('../api/admin/forward-performance')

test('shadow summary reports profit factor, cohorts, and concentration', () => {
  const rows = [
    { ticker: 'AAPL', scanned_at: '2026-07-27T15:00:00Z', realized_r_multiple: 1, shadow_strategy_assignments: { assignments: { entry_confirmation_v2b: true } } },
    { ticker: 'MSFT', scanned_at: '2026-07-28T15:00:00Z', realized_r_multiple: -0.5, shadow_strategy_assignments: { assignments: { entry_confirmation_v2b: true } } },
  ]
  const summary = _test.summarizeShadowStrategies(rows)[0]
  assert.equal(summary.resolved, 2)
  assert.equal(summary.profitFactor, 2)
  assert.equal(summary.cohortDays, 2)
  assert.equal(summary.tickerCount, 2)
  assert.equal(summary.expectancyR, 0.25)
})

test('defined-risk evidence uses actual spread returns, not single-leg R', () => {
  const rows = [{
    ticker: 'AAPL', scanned_at: '2026-07-27T15:00:00Z', realized_r_multiple: 2,
    shadow_spread_pnl_pct: -25,
    shadow_strategy_assignments: { assignments: { defined_risk_spread_v2e: true } },
  }]
  const summary = _test.summarizeShadowStrategies(rows)[0]
  assert.equal(summary.measurementBasis, 'ACTUAL_SPREAD_SETTLEMENT')
  assert.equal(summary.expectancyR, null)
  assert.equal(summary.averageReturnPct, -25)
  assert.equal(summary.winRate, 0)
})
