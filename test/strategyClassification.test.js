const test = require('node:test')
const assert = require('node:assert/strict')

const {
  classifyStrategy,
  buildQualificationRecord,
} = require('../api/_lib/strategyClassification')

const SWING = 'Swing (21–45 DTE)'
const QUICK = 'Quick (5–14 DTE)'

test('Qualified V1 includes only calls in the Swing DTE boundary', () => {
  assert.equal(classifyStrategy({ option_type: 'call', timeframe: SWING, dte_at_signal: 21 }), 'QUALIFIED_V1')
  assert.equal(classifyStrategy({ option_type: 'CALL', timeframe: SWING, dte_at_signal: 45 }), 'QUALIFIED_V1')
  assert.notEqual(classifyStrategy({ option_type: 'call', timeframe: SWING, dte_at_signal: 20 }), 'QUALIFIED_V1')
  assert.notEqual(classifyStrategy({ option_type: 'call', timeframe: SWING, dte_at_signal: 46 }), 'QUALIFIED_V1')
  assert.equal(classifyStrategy({ option_type: 'put', timeframe: SWING, dte_at_signal: 30 }), 'PUT_RESEARCH')
  assert.equal(classifyStrategy({ option_type: 'call', timeframe: QUICK, dte_at_signal: 10 }), 'QUICK_CALL_RESEARCH')
})

test('forward records separate premium stop from account risk', () => {
  const assignedAt = '2026-07-25T15:00:00.000Z'
  const record = buildQualificationRecord({
    option_type: 'call',
    timeframe: SWING,
    dte_at_signal: 30,
    profit_target_pct: 0.5,
    stop_loss_pct: 0.5,
  }, {
    assigned_at: assignedAt,
    qualification_source: 'LIVE_AT_SIGNAL',
  })

  assert.equal(record.strategy_qualified, true)
  assert.equal(record.premium_stop_loss_pct, 0.5)
  assert.equal(record.planned_account_risk_pct, null)
  assert.equal(record.planned_risk_pct, undefined)
  assert.equal(record.qualification_source, 'LIVE_AT_SIGNAL')
  assert.equal(record.experiment_cohort, 'forward_2026-07')
  assert.equal(record.experiment_enrolled_at, assignedAt)
})

test('research rows are not enrolled in a Qualified V1 cohort', () => {
  const record = buildQualificationRecord({
    option_type: 'put',
    timeframe: SWING,
    dte_at_signal: 30,
  }, { assigned_at: '2026-07-25T15:00:00.000Z' })

  assert.equal(record.strategy_qualified, false)
  assert.equal(record.experiment_cohort, null)
  assert.equal(record.experiment_enrolled_at, null)
})
