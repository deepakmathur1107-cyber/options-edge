const test = require('node:test')
const assert = require('node:assert/strict')
const { buildShadowStrategies } = require('../api/_lib/shadowStrategies')

test('assigns shadow candidates deterministically without changing the live strategy', () => {
  const result = buildShadowStrategies({
    option_type: 'call', long_term_trend: 'bullish', chg_pct: 0.8,
    entry_spread_pct: 12, volume: 100, open_interest: 1000,
    shadow_vertical_spread: { width: 5 },
    timeframe: 'Swing (21–45 DTE)',
    dmi_volume_confirmation: { status: 'MEASURED', bullish_confirmed: true, bearish_confirmed: false },
  })
  assert.equal(result.shadow_only, true)
  assert.equal(result.assignments.regime_aligned_v2a, true)
  assert.equal(result.assignments.entry_confirmation_v2b, true)
  assert.equal(result.assignments.liquidity_gate_v2c, true)
  assert.equal(result.assignments.combined_quality_v2d, true)
  assert.equal(result.assignments.swing_call_liquidity_entry_v3, true)
  assert.equal(result.assignments.defined_risk_spread_v2e, true)
  assert.equal(result.assignments.dmi_volume_confirmation_v1, true)
  assert.equal(result.exit_policies.partial_profit_v2g.partial_size_pct, 0.50)
  assert.equal(result.exit_policies.tighter_stop_v2h.stop_loss_pct, 0.35)
})

test('swing call liquidity-entry candidate excludes puts and Quick calls', () => {
  const base = {
    long_term_trend: 'bullish', chg_pct: 0.8,
    entry_spread_pct: 12, volume: 100, open_interest: 1000,
  }
  assert.equal(buildShadowStrategies({ ...base, option_type: 'put', timeframe: 'Swing (21–45 DTE)' })
    .assignments.swing_call_liquidity_entry_v3, false)
  assert.equal(buildShadowStrategies({ ...base, option_type: 'call', timeframe: 'Quick (5–14 DTE)' })
    .assignments.swing_call_liquidity_entry_v3, false)
})

test('bearish put candidate requires market, volatility, stock direction, and liquidity confirmation', () => {
  const candidate = buildShadowStrategies({
    option_type: 'put', timeframe: 'Quick (5–14 DTE)', chg_pct: -1.2,
    entry_spread_pct: 8, volume: 200, open_interest: 2000,
    regime_spx_chg_pct: -0.8, regime_ndx_chg_pct: -1.1, vix_chg_pct: 6,
  })
  assert.equal(candidate.assignments.bearish_regime_put_v1, true)

  const bullishMarket = buildShadowStrategies({
    option_type: 'put', timeframe: 'Quick (5–14 DTE)', chg_pct: -1.2,
    entry_spread_pct: 8, volume: 200, open_interest: 2000,
    regime_spx_chg_pct: 0.4, regime_ndx_chg_pct: 0.6, vix_chg_pct: -2,
  })
  assert.equal(bullishMarket.assignments.bearish_regime_put_v1, false)
})

test('volatility value remains shadow-only and uses breakeven versus expected move', () => {
  const favorable = buildShadowStrategies({
    option_type: 'call', timeframe: 'Swing (21–45 DTE)',
    expected_move_pct: 10, breakeven_required_pct: 6.5,
  })
  assert.equal(favorable.shadow_only, true)
  assert.equal(favorable.assignments.volatility_value_v1, true)
  assert.equal(favorable.inputs.volatility_value.breakeven_to_expected_move_ratio, 0.65)

  const unfavorable = buildShadowStrategies({
    option_type: 'call', timeframe: 'Swing (21–45 DTE)',
    expected_move_pct: 8, breakeven_required_pct: 9,
  })
  assert.equal(unfavorable.assignments.volatility_value_v1, false)
  assert.equal(unfavorable.inputs.volatility_value.status, 'MEASURED')

  const unavailable = buildShadowStrategies({ option_type: 'call' })
  assert.equal(unavailable.assignments.volatility_value_v1, false)
  assert.equal(unavailable.inputs.volatility_value.status, 'UNAVAILABLE')
})
