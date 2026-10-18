const test = require('node:test')
const assert = require('node:assert/strict')
const { isTransientStorageError, storeBriefReliably } = require('../api/_lib/reliableBriefStore')

test('recognizes timeouts and network failures as transient', () => {
  assert.equal(isTransientStorageError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true)
  assert.equal(isTransientStorageError({ status: 503, message: 'Service unavailable' }), true)
  assert.equal(isTransientStorageError({ code: '23505', message: 'duplicate key' }), false)
})

test('confirms an unknown timeout outcome before retrying the insert', async () => {
  let inserts = 0
  const row = { generated_at: '2026-10-19T13:00:00.000Z', bias: 'Neutral' }
  const result = await storeBriefReliably({
    row,
    insertRow: async () => {
      inserts += 1
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    },
    findByGeneratedAt: async () => row,
    sleep: async () => {},
    random: () => 0,
  })
  assert.equal(inserts, 1)
  assert.equal(result.recoveredAfterTimeout, true)
})

test('retries a transient failure and succeeds without duplicating work', async () => {
  let inserts = 0
  const delays = []
  const row = { generated_at: '2026-10-19T13:00:00.000Z', bias: 'Bullish' }
  const result = await storeBriefReliably({
    row,
    insertRow: async () => {
      inserts += 1
      if (inserts === 1) return { error: { status: 503, message: 'temporarily unavailable' } }
      return { data: row, error: null }
    },
    findByGeneratedAt: async () => null,
    sleep: async ms => delays.push(ms),
    random: () => 0,
  })
  assert.equal(inserts, 2)
  assert.deepEqual(delays, [250])
  assert.equal(result.attempts, 2)
})

test('does not retry permanent database errors', async () => {
  let inserts = 0
  await assert.rejects(storeBriefReliably({
    row: { generated_at: '2026-10-19T13:00:00.000Z' },
    insertRow: async () => {
      inserts += 1
      return { error: { code: '23505', message: 'duplicate key' } }
    },
    findByGeneratedAt: async () => null,
    sleep: async () => {},
  }), /duplicate key/)
  assert.equal(inserts, 1)
})
