const test = require('node:test')
const assert = require('node:assert/strict')
const { buildHistoricalStrategies, compareHistoricalSignals } = require('../api/_lib/strategyBacktest')
const { report } = require('../api/admin/strategy-backtest')._test

function signal(day, exitSpot = 108) {
  return {
    ticker: 'XYZ', timeframe: 'Swing (21–45 DTE)', option_type: 'call',
    primary_strike: 100, underlying_price: 100, underlying_price_at_resolution: exitSpot,
    iv: 0.30, dte_at_signal: 30, holding_minutes: 5 * 1440,
    scanned_at: `2026-01-${String(day).padStart(2, '0')}T15:00:00Z`,
    resolved_at: `2026-01-${String(day + 5).padStart(2, '0')}T15:00:00Z`,
  }
}

test('constructs long, debit, and defined-risk credit candidates from one historical signal', () => {
  assert.deepEqual(buildHistoricalStrategies(signal(1)).map(row => row.id), ['LONG_CALL', 'BULL_CALL_DEBIT', 'BULL_PUT_CREDIT'])
})

test('compares all structures with identical observation timing and realistic costs', () => {
  const comparisons = compareHistoricalSignals([signal(1), signal(2, 95)])
  assert.equal(comparisons.length, 3)
  assert.ok(comparisons.every(item => item.metrics.sampleSize === 2))
  assert.ok(comparisons.every(item => item.observations.every(row => row.evidenceType === 'MODELED_CONSTANT_IV')))
})

test('modeled historical report always fails the publication evidence check', () => {
  const result = report(Array.from({ length: 10 }, (_, index) => signal(index + 1)))
  assert.ok(result.length === 3)
  assert.ok(result.every(item => item.publishEligibleEvidence === false))
  assert.ok(result.every(item => item.profitabilityGate.decision === 'NO_TRADE'))
})
