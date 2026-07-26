const test = require('node:test')
const assert = require('node:assert/strict')
const { buildShadowStrategies } = require('../api/_lib/shadowStrategies')

test('assigns shadow candidates deterministically without changing the live strategy', () => {
  const result = buildShadowStrategies({
    option_type: 'call', long_term_trend: 'bullish', chg_pct: 0.8,
    entry_spread_pct: 12, volume: 100, open_interest: 1000,
    shadow_vertical_spread: { width: 5 },
  })
  assert.equal(result.shadow_only, true)
  assert.equal(result.assignments.regime_aligned_v2a, true)
  assert.equal(result.assignments.entry_confirmation_v2b, true)
  assert.equal(result.assignments.liquidity_gate_v2c, true)
  assert.equal(result.assignments.combined_quality_v2d, true)
  assert.equal(result.assignments.defined_risk_spread_v2e, true)
  assert.equal(result.exit_policies.partial_profit_v2g.partial_size_pct, 0.50)
  assert.equal(result.exit_policies.tighter_stop_v2h.stop_loss_pct, 0.35)
})
