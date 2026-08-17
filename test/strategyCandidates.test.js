const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCreditSpread, buildStrategyCandidates } = require('../api/_lib/strategyCandidates')

function leg(optionType, strike, delta, bid, ask) {
  return { option_type: optionType, strike, bid, ask, volume: 500, open_interest: 2000, greeks: { delta } }
}

const chain = [
  leg('call', 100, 0.52, 4.8, 5.0), leg('call', 105, 0.31, 2.2, 2.35), leg('call', 110, 0.18, 0.9, 1.0),
  leg('call', 115, 0.10, 0.35, 0.4), leg('call', 120, 0.05, 0.1, 0.15),
  leg('put', 100, -0.48, 4.5, 4.7), leg('put', 95, -0.27, 2.0, 2.15), leg('put', 90, -0.14, 0.7, 0.8),
  leg('put', 85, -0.07, 0.2, 0.25), leg('put', 80, -0.03, 0.05, 0.1),
]

test('builds a conservative defined-risk bull put credit from the same chain', () => {
  const spread = buildCreditSpread(chain, 100, 1, 'call', 4)
  assert.equal(spread.id, 'BULL_PUT_CREDIT')
  assert.ok(spread.entryCredit > 0)
  assert.ok(spread.maxLoss > 0)
  assert.equal(spread.legs.length, 2)
})

test('emits A/B/C coverage without selecting or publishing a strategy', () => {
  const result = buildStrategyCandidates({
    chain, price: 100, step: 1, direction: 'call', timeframe: 'Swing (21–45 DTE)',
    selected: {
      bid: 4.8, ask: 5, mid: 4.9, primaryStrike: 100,
      shadowSpread: { long_strike: 100, short_strike: 110, net_debit: 4, max_profit: 6, max_loss: 4, breakeven_price: 104, spread_width: 10 },
    },
  })
  assert.equal(result.shadowOnly, true)
  assert.equal(result.coverage.completeComparison, true)
  assert.deepEqual(result.candidates.map(candidate => candidate.family), ['LONG_OPTION', 'DEFINED_RISK_DEBIT', 'DEFINED_RISK_CREDIT'])
  assert.equal('publish' in result, false)
})

test('fails closed when the protective credit leg is not executable', () => {
  const broken = chain.map(item => item.option_type === 'put' && item.strike < 95 ? { ...item, bid: 0, ask: 0 } : item)
  assert.equal(buildCreditSpread(broken, 100, 1, 'call', 4), null)
})
