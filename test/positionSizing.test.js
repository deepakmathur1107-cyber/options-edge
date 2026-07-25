const test = require('node:test')
const assert = require('node:assert/strict')

const { calculateContracts } = require('../api/_lib/positionSizing')

test('normal case: sizes a single contract within the account risk budget', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 1)
  assert.equal(r.reason, null)
  assert.equal(r.maxLossPerContract, 100)
  assert.equal(r.accountRiskBudget, 125)
})

test('unaffordable position returns zero contracts with a reason, not a crash', () => {
  const r = calculateContracts({ accountEquity: 1000, entryPremium: 10.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'unaffordable')
})

test('invalid input (zero account equity) returns zero contracts, never throws', () => {
  const r = calculateContracts({ accountEquity: 0, entryPremium: 2.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('invalid input (negative premium) returns zero contracts', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: -1, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('missing required params entirely returns zero contracts, not a crash', () => {
  const r = calculateContracts({})
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('spread too wide is rejected before any sizing math runs', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025, entrySpreadPct: 45, maxSpreadPctAllowed: 20 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'spread_too_wide')
})

test('spread within the allowed limit proceeds with normal sizing', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025, entrySpreadPct: 15, maxSpreadPctAllowed: 20 })
  assert.equal(r.contracts, 1)
})

test('maxContracts caps an otherwise-large calculated position size', () => {
  const r = calculateContracts({ accountEquity: 5000000, entryPremium: 1.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025, maxContracts: 3 })
  assert.equal(r.contracts, 3)
})

test('without maxContracts specified, a large position is not artificially capped', () => {
  const r = calculateContracts({ accountEquity: 5000000, entryPremium: 1.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 250)
})
