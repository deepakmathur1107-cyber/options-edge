const test = require('node:test')
const assert = require('node:assert/strict')
const { buildDirectionStability } = require('../api/_lib/directionStability')

const base = { ticker: 'TSLA', timeframe: 'Quick (5–14 DTE)' }

test('flags a recent same-timeframe direction change', () => {
  const current = { ...base, option_type: 'call', scanned_at: '2026-07-31T18:31:00Z', signal_lifecycle_id: 'call-1' }
  const history = [{ ...base, option_type: 'put', scanned_at: '2026-07-31T18:15:00Z', signal_lifecycle_id: 'put-1' }]
  const result = buildDirectionStability(current, history)
  assert.equal(result.status, 'DIRECTION_CHANGED')
  assert.equal(result.eligible, false)
  assert.equal(result.minutes_between, 16)
})

test('does not flag an old opposing observation', () => {
  const current = { ...base, option_type: 'call', scanned_at: '2026-07-31T18:31:00Z' }
  const history = [{ ...base, option_type: 'put', scanned_at: '2026-07-31T15:00:00Z' }]
  assert.equal(buildDirectionStability(current, history).status, 'STABLE')
})

test('distinguishes verified losses on both lifecycle directions', () => {
  const current = { ...base, option_type: 'call', scanned_at: '2026-07-31T18:31:00Z', signal_lifecycle_id: 'call-1' }
  const history = [
    { ...base, option_type: 'call', scanned_at: '2026-07-31T18:31:00Z', signal_lifecycle_id: 'call-1', outcome: 'LOSS' },
    { ...base, option_type: 'put', scanned_at: '2026-07-31T18:15:00Z', signal_lifecycle_id: 'put-1', outcome: 'LOSS' },
  ]
  const result = buildDirectionStability(current, history)
  assert.equal(result.status, 'BOTH_SIDES_FAILED')
  assert.equal(result.both_sides_failed, true)
})

test('does not mix timeframes when checking reversals', () => {
  const current = { ...base, option_type: 'call', scanned_at: '2026-07-31T18:31:00Z' }
  const history = [{ ...base, timeframe: 'Swing (21–45 DTE)', option_type: 'put', scanned_at: '2026-07-31T18:15:00Z' }]
  assert.equal(buildDirectionStability(current, history).status, 'STABLE')
})
