const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluatePromotion } = require('../api/_lib/promotionGates')

function rows(count, cohort, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    outcome: (index % 5) < 3 ? 'WIN' : 'LOSS',
    realized_r_multiple: (index % 5) < 3 ? 1 : -1,
    experiment_cohort: cohort,
    ticker: `T${index % 20}`,
    sector: `S${index % 5}`,
    scanned_at: new Date(Date.UTC(2026, 6, 1, 0, offset + index)).toISOString(),
  }))
}

test('promotion remains blocked while no forward measurement exists', () => {
  const result = evaluatePromotion([])
  assert.equal(result.eligible, false)
  assert.equal(result.status, 'WAITING_FOR_FORWARD_RESOLUTIONS')
})

test('promotion requires every sample, expectancy, profit factor, and concentration gate', () => {
  const result = evaluatePromotion([
    ...rows(150, 'forward_2026-07'),
    ...rows(150, 'forward_2026-08', 150),
  ])
  assert.equal(result.metrics.resolved, 300)
  assert.equal(result.checks.sampleSize, true)
  assert.equal(result.checks.cohortCount, true)
  assert.equal(result.checks.positiveExpectancy, true)
  assert.equal(result.checks.profitFactor, true)
  assert.equal(result.checks.maximumDrawdown, true)
  assert.equal(result.checks.cohortStability, true)
  assert.equal(result.eligible, true)
})
