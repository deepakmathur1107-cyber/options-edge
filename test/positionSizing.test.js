const test = require('node:test')
const assert = require('node:assert/strict')

const { calculateContracts } = require('../api/_lib/positionSizing')

test('normal case: sizes a single contract within the account risk budget', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 1)
  assert.equal(r.reason, null)
  assert.equal(r.plannedStopLoss, 100)
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

// ── Validation report fixes: reproducing the exact bugs found, confirming each is fixed ──

test('fractional maxContracts is rejected as invalid input, never produces fractional contracts', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 1, premiumStopLossPct: 0.5, plannedAccountRiskPct: 0.01, maxContracts: 2.5 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
  assert.ok(Number.isInteger(r.contracts))
})

test('non-finite accountEquity (Infinity) is rejected, not silently propagated', () => {
  const r = calculateContracts({ accountEquity: Infinity, entryPremium: 2, premiumStopLossPct: 0.5, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('non-finite entryPremium (NaN) is rejected', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: NaN, premiumStopLossPct: 0.5, plannedAccountRiskPct: 0.0025 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('requesting 100% account risk is capped to the hard ceiling, with a warning', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 0.5, plannedAccountRiskPct: 1.0 })
  assert.ok(r.accountRiskBudget <= 50000 * 0.02)
  assert.ok(r.warnings.length > 0)
  assert.ok(r.warnings[0].includes('hard ceiling'))
})

test('worst-case premium loss is distinct from and greater than the planned stop loss', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 0.5, plannedAccountRiskPct: 0.02 })
  assert.ok(r.worstCasePremiumLoss > r.plannedStopLoss)
  // premiumStopLossPct=0.5 means worst case should be exactly double the planned stop
  assert.equal(r.worstCasePremiumLoss, r.plannedStopLoss * 2)
})

test('premium outlay cap can bind even when the stop-risk budget would allow more contracts', () => {
  // A low maxPremiumOutlayPct relative to the risk budget forces the
  // outlay cap to bind before the stop-risk budget does.
  const r = calculateContracts({ accountEquity: 10000, entryPremium: 0.10, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.02, maxPremiumOutlayPct: 0.01 })
  assert.equal(r.bindingConstraint, 'premium_outlay_cap')
  assert.equal(r.contracts, 10)
  assert.ok(r.premiumOutlayPct <= 1.01) // should not exceed the 1% cap used in this test (small float tolerance)
})

test('maxContracts caps an otherwise-larger calculated position size', () => {
  const r = calculateContracts({ accountEquity: 5000000, entryPremium: 1.00, premiumStopLossPct: 0.50, plannedAccountRiskPct: 0.02, maxContracts: 3 })
  assert.equal(r.contracts, 3)
  assert.equal(r.bindingConstraint, 'max_contracts_cap')
})

test('contractMultiplier must be a positive integer', () => {
  const r = calculateContracts({ accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 0.5, plannedAccountRiskPct: 0.02, contractMultiplier: 100.5 })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('caller cannot override the absolute account-risk ceiling', () => {
  const r = calculateContracts({
    accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 0.5,
    plannedAccountRiskPct: 0.02, maxAccountRiskPct: 0.50,
  })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('caller cannot override the absolute premium-outlay ceiling', () => {
  const r = calculateContracts({
    accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 0.5,
    plannedAccountRiskPct: 0.02, maxPremiumOutlayPct: 0.50,
  })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('percentage fractions above one are rejected', () => {
  const r = calculateContracts({
    accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 50,
    plannedAccountRiskPct: 0.02,
  })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})

test('spread inputs must be finite and non-negative', () => {
  const r = calculateContracts({
    accountEquity: 50000, entryPremium: 2, premiumStopLossPct: 0.5,
    plannedAccountRiskPct: 0.02, entrySpreadPct: -1, maxSpreadPctAllowed: 20,
  })
  assert.equal(r.contracts, 0)
  assert.equal(r.reason, 'invalid_input')
})
