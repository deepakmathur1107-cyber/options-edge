const test = require('node:test')
const assert = require('node:assert/strict')
const { summarizeMultilegStrategies } = require('../api/admin/forward-performance')._test

function row(cohort, value, strategyId = 'BULL_CALL_DEBIT') {
  return {
    ticker: 'XYZ', option_type: 'call', timeframe: 'Swing (21–45 DTE)',
    experiment_cohort: cohort, scanned_at: '2026-08-01T15:00:00Z',
    shadow_strategy_assignments: { multileg_resolution: {
      version: 'synchronized_multileg_v1', dataStatus: 'COMPLETE', publishEligibleEvidence: true,
      holdingMinutes: 1440, exitAt: '2026-08-02T15:00:00Z',
      candidates: [{ strategyId, returnOnRisk: value }],
    } },
  }
}

test('reports each exact strategy, direction, timeframe, and resolver version separately', () => {
  const result = summarizeMultilegStrategies([row('forward_2026-08', 0.2), row('forward_2026-09', -0.1)])
  assert.equal(result.length, 1)
  assert.match(result[0].strategyKey, /BULL_CALL_DEBIT\|call\|Swing/)
  assert.equal(result[0].metrics.sampleSize, 2)
  assert.equal(result[0].profitabilityGate.decision, 'NO_TRADE')
})

test('excludes unavailable and partial comparisons from evidence', () => {
  const incomplete = row('forward_2026-08', 5)
  incomplete.shadow_strategy_assignments.multileg_resolution.dataStatus = 'UNAVAILABLE'
  incomplete.shadow_strategy_assignments.multileg_resolution.publishEligibleEvidence = false
  assert.deepEqual(summarizeMultilegStrategies([incomplete]), [])
})
