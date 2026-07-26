const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveResolverRunHealth } = require('../api/_lib/resolverHealth')

const now = Date.parse('2026-07-25T21:00:00.000Z')
const run = (overrides = {}) => ({
  started_at: '2026-07-25T20:54:00.000Z',
  finished_at: '2026-07-25T20:55:00.000Z',
  rows_processed: 100,
  resolved: 50,
  errors: 0,
  circuit_broken: false,
  status_counts: { 200: 10 },
  ...overrides,
})

test('does not infer a resolver stall from outcome throughput without run telemetry', () => {
  const result = deriveResolverRunHealth({ runs: [], truePending: 100, now })
  assert.deepEqual(result.healthStates, ['NO_RUN_TELEMETRY'])
})

test('reports healthy backlog processing from recent run evidence', () => {
  const result = deriveResolverRunHealth({ runs: [run()], truePending: 100, now })
  assert.deepEqual(result.healthStates, ['HEALTHY_PROCESSING_BACKLOG'])
  assert.equal(result.lastRunAgeMinutes, 5)
})

test('reports no progress only when recent runs processed rows without resolving any', () => {
  const result = deriveResolverRunHealth({
    runs: [run({ resolved: 0 }), run({ resolved: 0 }), run({ resolved: 0 })],
    truePending: 100,
    now,
  })
  assert.ok(result.healthStates.includes('RESOLVER_NO_PROGRESS'))
})

test('classifies rate limits independently from upstream failures', () => {
  const result = deriveResolverRunHealth({
    runs: [run({ circuit_broken: true, status_counts: { 429: 1 } })],
    truePending: 100,
    now,
  })
  assert.ok(result.healthStates.includes('RATE_LIMITED'))
  assert.ok(!result.healthStates.includes('UPSTREAM_DEGRADED'))
})

test('classifies bad requests, auth failures, and server failures separately', () => {
  const result = deriveResolverRunHealth({
    runs: [run({ status_counts: { 400: 2, 401: 1, 500: 1 } })],
    truePending: 100,
    now,
  })
  assert.ok(result.healthStates.includes('BAD_REQUEST_BURST'))
  assert.ok(result.healthStates.includes('AUTH_FAILURE'))
  assert.ok(result.healthStates.includes('UPSTREAM_DEGRADED'))
})

test('reports stale run telemetry independently of the unresolved backlog', () => {
  const result = deriveResolverRunHealth({
    runs: [run({ finished_at: '2026-07-25T20:00:00.000Z' })],
    truePending: 100,
    now,
  })
  assert.ok(result.healthStates.includes('NO_RECENT_RESOLVER_RUN'))
})
