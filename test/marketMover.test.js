const test = require('node:test')
const assert = require('node:assert/strict')

test('market mover requires confirmation, quality, and favorable value for TAKE', async () => {
  const { classifyMarketMover } = await import('../src/lib/marketMover.js')
  const result = classifyMarketMover({
    symbol: 'SPX', optionType: 'call', price: 102,
    quote: { open: 100, high: 102, low: 99 },
    spxChange: 0.8, ndxChange: 1.1,
    expectedMovePct: 2, breakevenRequiredPct: 1.2,
    baseEligible: true,
  })
  assert.equal(result.setupType, 'MOMENTUM BREAKOUT')
  assert.equal(result.decision, 'TAKE')
  assert.equal(result.valueFavorable, true)
})

test('market mover returns TAKE ON TRIGGER for an aligned developing reclaim', async () => {
  const { classifyMarketMover } = await import('../src/lib/marketMover.js')
  const result = classifyMarketMover({
    symbol: 'NDX', optionType: 'put', price: 99.5,
    quote: { open: 100, high: 102, low: 98 },
    spxChange: -0.5, ndxChange: -0.9,
    expectedMovePct: 2.5, breakevenRequiredPct: 1.5,
    baseEligible: true,
  })
  assert.equal(result.setupType, 'PULLBACK & RECLAIM')
  assert.equal(result.decision, 'TAKE_ON_TRIGGER')
  assert.ok(result.triggerPrice < 100)
})

test('market mover does not recommend conflicting indices or expensive premium', async () => {
  const { classifyMarketMover } = await import('../src/lib/marketMover.js')
  const conflicting = classifyMarketMover({
    symbol: 'SPX', optionType: 'call', price: 102,
    quote: { open: 100, high: 102, low: 99 },
    spxChange: 0.5, ndxChange: -0.4,
    expectedMovePct: 2, breakevenRequiredPct: 1,
    baseEligible: true,
  })
  assert.equal(conflicting.decision, 'NO_TRADE')

  const expensive = classifyMarketMover({
    symbol: 'SPX', optionType: 'call', price: 102,
    quote: { open: 100, high: 102, low: 99 },
    spxChange: 0.5, ndxChange: 0.4,
    expectedMovePct: 1, breakevenRequiredPct: 1.1,
    baseEligible: true,
  })
  assert.notEqual(expensive.decision, 'TAKE')
})
