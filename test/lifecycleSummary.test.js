const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyLifecycle } = require('../api/_lib/lifecycleSummary')

test('classifies qualified regular-session signals as live forward evidence', () => {
  assert.deepEqual(classifyLifecycle({
    qualification_source: 'LIVE_AT_SIGNAL',
    market_session_status: 'LIVE_REGULAR_SESSION',
    strategy_qualified: true,
  }), { status: 'LIVE', measurement: 'FORWARD_COHORT' })
})

test('classifies closed-market and historical signals as research', () => {
  assert.deepEqual(classifyLifecycle({
    qualification_source: 'LIVE_AT_SIGNAL',
    market_session_status: 'WEEKEND_RESEARCH',
    strategy_qualified: true,
  }), { status: 'RESEARCH', measurement: 'EXCLUDED' })
})

test('classifies resolved and data-unavailable lifecycle outcomes explicitly', () => {
  assert.deepEqual(classifyLifecycle({
    resolved_at: '2026-07-27T20:00:00Z',
    outcome: 'WIN',
    realized_r_multiple: 1.2,
  }), { status: 'RESOLVED', measurement: 'MEASURED' })
  assert.deepEqual(classifyLifecycle({
    resolved_at: '2026-07-27T20:00:00Z',
    resolution_method: 'data_unavailable',
  }), { status: 'DATA_UNAVAILABLE', measurement: 'EXCLUDED' })
})
