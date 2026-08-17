const test = require('node:test')
const assert = require('node:assert/strict')
const { blackScholes, expectedMovePct } = require('../api/_lib/optionsModel')

test('computes finite Greeks and expected move', () => {
  const call = blackScholes({ spot: 100, strike: 100, years: 30 / 365, volatility: 0.30, optionType: 'call' })
  assert.ok(call.price > 0)
  assert.ok(call.delta > 0 && call.delta < 1)
  assert.ok(call.gamma > 0)
  assert.ok(call.vega > 0)
  assert.ok(call.theta < 0)
  assert.ok(expectedMovePct(0.30, 30) > 0)
})
