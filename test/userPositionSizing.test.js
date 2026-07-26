const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDisplayNumber, buildSizingForScanRow } = require('../api/_lib/userPositionSizing')

test('parses formatted market values without accepting non-numeric strings', () => {
  assert.equal(parseDisplayNumber('$1,234.50'), 1234.5)
  assert.equal(parseDisplayNumber('12.5%'), 12.5)
  assert.equal(parseDisplayNumber('n/a'), null)
})

test('returns an explicit unconfigured response without account equity', () => {
  const result = buildSizingForScanRow({ entry: '$2.00', stop: '$1.00' }, {})
  assert.equal(result.configured, false)
  assert.equal(result.reason, 'account_equity_not_configured')
})

test('calculates a server-side educational contract suggestion from scan pricing', () => {
  const result = buildSizingForScanRow({
    entry: '$2.00',
    stop: '$1.00',
    bid: '$1.90',
    ask: '$2.10',
  }, {
    account_equity: 50000,
    planned_account_risk_pct: 0.0025,
    max_premium_outlay_pct: 0.10,
    max_position_contracts: 10,
  })
  assert.equal(result.configured, true)
  assert.equal(result.contracts, 1)
  assert.equal(result.plannedStopLoss, 100)
})
