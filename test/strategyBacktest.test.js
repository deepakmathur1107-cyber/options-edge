const test = require('node:test')
const assert = require('node:assert/strict')
const { modelObservation } = require('../api/_lib/strategyBacktest')

const signal = {
  ticker: 'XYZ', underlying_price: 100, underlying_price_at_resolution: 108,
  iv: 0.30, dte_at_signal: 30, holding_minutes: 5 * 1440,
  scanned_at: '2026-01-01T15:00:00Z', resolved_at: '2026-01-06T15:00:00Z',
}

test('models long, debit, and defined-risk credit structures at identical timing', () => {
  const strategies = [
    { id: 'LONG_CALL', legs: [{ optionType: 'call', strike: 100, quantity: 1 }], maxLoss: 5 },
    { id: 'BULL_CALL_DEBIT', legs: [{ optionType: 'call', strike: 100, quantity: 1 }, { optionType: 'call', strike: 110, quantity: -1 }], maxLoss: 4 },
    { id: 'BULL_PUT_CREDIT', legs: [{ optionType: 'put', strike: 95, quantity: -1 }, { optionType: 'put', strike: 90, quantity: 1 }], maxLoss: 4 },
  ]
  const results = strategies.map(strategy => modelObservation(signal, strategy))
  assert.equal(results.filter(Boolean).length, 3)
  assert.ok(results.every(result => result.holdingMinutes === signal.holding_minutes))
  assert.ok(results.every(result => Number.isFinite(result.returnOnRisk)))
})
