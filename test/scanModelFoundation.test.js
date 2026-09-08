const test = require('node:test')
const assert = require('node:assert/strict')
const { buildModelFoundation } = require('../api/_lib/scanLogic')

test('captures complete modeled Greeks, expected move, and breakeven ratio', () => {
  const result = buildModelFoundation({
    spot: 100,
    strike: 102,
    dte: 30,
    iv: 0.3,
    optionType: 'call',
    breakevenReqPct: 5,
  })
  assert.ok(Number.isFinite(result.theta))
  assert.ok(Number.isFinite(result.gamma))
  assert.ok(Number.isFinite(result.vega))
  assert.ok(result.expectedMovePct > 0)
  assert.equal(result.breakevenExpectedMoveRatio, 5 / result.expectedMovePct)
})

test('prefers live Tradier Greeks while modeling missing values', () => {
  const result = buildModelFoundation({
    spot: 100,
    strike: 100,
    dte: 14,
    iv: 0.25,
    optionType: 'put',
    tradierGreeks: { theta: -0.123 },
  })
  assert.equal(result.theta, -0.123)
  assert.ok(Number.isFinite(result.gamma))
  assert.ok(Number.isFinite(result.vega))
})
