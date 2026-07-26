const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveScannerHealth } = require('../api/_lib/adminHealth')

test('scanner is paused, not degraded, while the market is closed', () => {
  const result = deriveScannerHealth({
    lastObservedAt: '2026-07-24T19:45:00Z',
    now: new Date('2026-07-26T18:00:00Z'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'paused')
})

test('scanner is degraded when stale during a regular session', () => {
  const result = deriveScannerHealth({
    lastObservedAt: '2026-07-27T14:00:00Z',
    now: new Date('2026-07-27T15:00:00Z'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'degraded')
})

test('scanner is operational when fresh during a regular session', () => {
  const result = deriveScannerHealth({
    lastObservedAt: '2026-07-27T14:50:00Z',
    now: new Date('2026-07-27T15:00:00Z'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'operational')
})
