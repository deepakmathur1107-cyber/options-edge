const test = require('node:test')
const assert = require('node:assert/strict')
const { buildProfitabilityMetrics } = require('../api/_lib/profitabilityMetrics')

test('builds conservative execution-adjusted metrics for a target hit', () => {
  const metrics = buildProfitabilityMetrics({
    entry_mid: 2, ask: 2.10, profit_target_pct: 0.5, stop_loss_pct: 0.5,
    scanned_at: '2026-07-27T14:00:00Z',
  }, {
    outcome: 'WIN', hit_target_at: '2026-07-27T15:00:00Z',
    resolved_at: '2026-07-27T15:01:00Z',
    _maxOptionHigh: 3.2,
    _minOptionLow: 1.8,
  })
  assert.equal(metrics.measurement_version, 'execution_v1')
  assert.equal(metrics.holding_minutes, 60)
  assert.ok(metrics.estimated_entry_price > 2.10)
  assert.ok(metrics.estimated_exit_price < 3)
  assert.ok(metrics.estimated_net_pnl_pct < metrics.gross_pnl_pct)
  assert.ok(metrics.realized_r_multiple > 0)
  assert.ok(metrics.max_favorable_excursion_pct > 0)
  assert.ok(metrics.max_adverse_excursion_pct < 0)
})

test('a stop hit produces negative net expectancy and tolerates a missing ask', () => {
  const metrics = buildProfitabilityMetrics({
    entry_mid: 4, ask: null, profit_target_pct: 0.8, stop_loss_pct: 0.5,
    scanned_at: '2026-07-27T14:00:00Z',
  }, {
    outcome: 'LOSS', hit_stop_at: '2026-07-28T14:00:00Z',
    resolved_at: '2026-07-28T14:01:00Z',
  })
  assert.ok(metrics.estimated_net_pnl_pct < 0)
  assert.ok(metrics.realized_r_multiple < 0)
})
