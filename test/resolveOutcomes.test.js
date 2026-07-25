const test = require('node:test')
const assert = require('node:assert/strict')

const resolver = require('../api/cron/resolve-outcomes')._test

function row(overrides = {}) {
  return {
    ticker: 'AAPL',
    option_type: 'call',
    primary_strike: 200,
    expiry_raw: '2026-07-31',
    entry_mid: 1,
    profit_target_pct: 0.5,
    stop_loss_pct: 0.5,
    scanned_at: '2026-07-24T15:00:00.000Z',
    last_walked_through: null,
    ...overrides,
  }
}

test('pending filter excludes terminal null-outcome dead letters', () => {
  const calls = []
  const fakeQuery = {
    is(column, value) {
      calls.push([column, value])
      return this
    },
  }
  assert.equal(resolver.addPendingResolutionFilters(fakeQuery), fakeQuery)
  assert.deepEqual(calls, [['outcome', null], ['resolved_at', null]])
})

test('dead letter is terminal and propagated to the complete lifecycle', () => {
  const calls = []
  const query = {
    update(payload) {
      calls.push(['update', payload])
      return this
    },
    eq(column, value) {
      calls.push(['eq', column, value])
      return this
    },
  }
  const client = {
    from(table) {
      calls.push(['from', table])
      return query
    },
  }
  const resolvedAt = '2026-07-25T15:00:00.000Z'

  assert.equal(
    resolver.buildDeadLetterQuery(client, { id: 'row-1', signal_lifecycle_id: 'life-1' }, 5, resolvedAt),
    query,
  )
  assert.deepEqual(calls, [
    ['from', 'signal_history'],
    ['update', {
      resolve_attempts: 5,
      resolution_method: 'data_unavailable',
      resolved_at: resolvedAt,
    }],
    ['eq', 'signal_lifecycle_id', 'life-1'],
  ])
})

test('same-bar target and stop collision is conservatively a loss', () => {
  assert.deepEqual(
    resolver.findFirstThresholdHit([{ high: 1.6, low: 0.4, time: 't' }], 1.5, 0.5),
    { type: 'same_bar_tiebreak', outcome: 'LOSS', at: 't' },
  )
})

test('first threshold hit wins when target and stop occur in different bars', () => {
  assert.deepEqual(
    resolver.findFirstThresholdHit([
      { high: 1.6, low: 1.1, time: 'target-first' },
      { high: 1.1, low: 0.4, time: 'stop-second' },
    ], 1.5, 0.5),
    { type: 'target_hit', outcome: 'WIN', at: 'target-first' },
  )
})

test('entry day detects a target hit after the signal timestamp', async () => {
  let requestedStart = null
  const result = await resolver.resolveOne(row(), {}, {
    now: '2026-07-24T19:00:00.000Z',
    getOptionTimesales: async (_symbol, start) => {
      requestedStart = start
      return [{ high: 1.6, low: 1.1, time: '2026-07-24T16:00:00.000Z' }]
    },
    getOptionHistory: async () => [],
  })

  assert.equal(requestedStart, '2026-07-24 11:00')
  assert.equal(result.outcome, 'WIN')
  assert.equal(result.resolution_method, 'target_hit')
})

test('entry day ignores bars before the signal', async () => {
  const result = await resolver.resolveOne(row(), {}, {
    now: '2026-07-24T19:00:00.000Z',
    getOptionTimesales: async () => [
      { high: 1.6, low: 1.1, time: '2026-07-24T14:00:00.000Z' },
      { high: 1.2, low: 0.8, time: '2026-07-24T16:00:00.000Z' },
    ],
    getOptionHistory: async () => [],
  })

  assert.equal(result._stillOpen, true)
  assert.equal(result.outcome, undefined)
})

test('aged entry-day crossing is ambiguous, not fabricated WIN/LOSS', async () => {
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-06-26T15:00:00.000Z', expiry_raw: '2026-07-02' }),
    {},
    {
      now: '2026-07-25T15:00:00.000Z',
      getOptionHistory: async () => [{ high: 1.6, low: 0.8, close: 1.2 }],
      getOptionTimesales: async () => {
        throw new Error('aged entry day must not request timesales')
      },
    },
  )

  assert.equal(result.outcome, 'AMBIGUOUS')
  assert.equal(result.resolution_method, 'entry_day_daily_crossing_unverifiable')
})

test('resume cursor starts after the last confirmed-clean day', async () => {
  const requestedDays = []
  const result = await resolver.resolveOne(row({
    last_walked_through: '2026-07-23',
  }), {}, {
    now: '2026-07-24T19:00:00.000Z',
    getOptionHistory: async (_symbol, start) => {
      requestedDays.push(start)
      return [{ high: 1.2, low: 0.8, close: 1 }]
    },
    getOptionTimesales: async () => [],
  })

  assert.deepEqual(requestedDays, ['2026-07-24'])
  assert.equal(result._stillOpen, true)
})
