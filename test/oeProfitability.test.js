const test = require('node:test')
const assert = require('node:assert/strict')
const { summarizeReturns, evaluateProfitabilityGate, calculateOEProfitabilityScore } = require('../api/_lib/oeProfitability')

function observations(count, value) {
  return Array.from({ length: count }, (_, index) => ({ returnOnRisk: index % 5 === 4 ? -0.5 : value, holdingMinutes: 1440 }))
}

test('summarizes all required profitability metrics', () => {
  const metrics = summarizeReturns(observations(100, 0.4))
  assert.equal(metrics.sampleSize, 100)
  assert.ok(metrics.winRate > 0)
  assert.ok(metrics.expectancy > 0)
  assert.ok(metrics.profitFactor > 1)
  assert.ok(metrics.averageWin > 0)
  assert.ok(metrics.averageLoss < 0)
  assert.ok(metrics.maxDrawdown >= 0)
  assert.ok(metrics.sharpe > 0)
  assert.equal(metrics.averageHoldingMinutes, 1440)
})

test('hard gate rejects missing evidence and negative out-of-sample expectancy', () => {
  assert.equal(evaluateProfitabilityGate().decision, 'NO_TRADE')
  const result = evaluateProfitabilityGate({
    partition: 'OUT_OF_SAMPLE', cohorts: 2, costModelApplied: true, sameSignalTiming: true,
    outOfSample: summarizeReturns(observations(300, 0.05)),
  })
  assert.equal(result.publish, false)
  assert.equal(result.checks.positiveExpectancy, false)
})

test('score cannot override the profitability gate', () => {
  const result = calculateOEProfitabilityScore({
    validation: { partition: 'IN_SAMPLE', cohorts: 4, costModelApplied: true, sameSignalTiming: true, outOfSample: summarizeReturns(observations(400, 0.5)) },
    liquidity: { spreadPct: 1 }, quoteQuality: { live: true, complete: true },
  })
  assert.ok(result.score > 50)
  assert.equal(result.decision, 'NO_TRADE')
})
