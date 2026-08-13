const test = require('node:test')
const assert = require('node:assert/strict')

const resolver = require('../api/cron/resolve-outcomes')._test

test('resolver mode reserves a small qualified queue', () => {
  assert.deepEqual(resolver.resolverModeConfig({ qualified: '1' }), {
    qualifiedMode: true,
    burndownMode: false,
    batchLimit: 25,
    maxTradierCalls: 100,
  })
  assert.equal(resolver.resolverModeConfig({ burndown: '1', limit: '75' }).batchLimit, 75)
})

test('resolver API budget preserves call and rate-limit headroom', () => {
  assert.equal(resolver.rateBudgetReached({ calls: 99, minAvailable: 76 }, 100), false)
  assert.equal(resolver.rateBudgetReached({ calls: 100, minAvailable: 100 }, 100), true)
  assert.equal(resolver.rateBudgetReached({ calls: 10, minAvailable: 75 }, 100), true)
  assert.equal(resolver.rateBudgetReached({ calls: 10, minAvailable: null }, 100), false)
})

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

test('missing walk extrema stay null instead of becoming a false zero', async () => {
  const result = await resolver.resolveOne(row({ last_walked_through: '2026-07-24' }), {}, {
    now: '2026-07-24T20:00:00.000Z',
    getOptionTimesalesDetailed: async () => ({ ok: true, bars: [] }),
    getOptionHistoryDetailed: async () => ({ ok: true, days: [] }),
  })
  assert.equal(result._maxOptionHigh, null)
  assert.equal(result._minOptionLow, null)
})

test('burndown only runs after a real trading session has closed', () => {
  assert.equal(resolver.shouldRunBurndownNow(new Date('2026-07-26T20:00:00Z')), false)
  assert.equal(resolver.shouldRunBurndownNow(new Date('2026-07-27T19:00:00Z')), false)
  assert.equal(resolver.shouldRunBurndownNow(new Date('2026-07-27T20:20:00Z')), true)
})

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
    getOptionTimesalesDetailed: async (_symbol, start) => {
      requestedStart = start
      return { ok: true, errorType: null, retryable: false, status: 200,
        bars: [{ high: 1.6, low: 1.1, time: '2026-07-24T16:00:00.000Z' }] }
    },
    getOptionHistoryDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200, days: [] }),
  })

  assert.equal(requestedStart, '2026-07-24 11:00')
  assert.equal(result.outcome, 'WIN')
  assert.equal(result.resolution_method, 'target_hit')
})

test('entry day ignores bars before the signal', async () => {
  const result = await resolver.resolveOne(row(), {}, {
    now: '2026-07-24T19:00:00.000Z',
    getOptionTimesalesDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200, bars: [
      { high: 1.6, low: 1.1, time: '2026-07-24T14:00:00.000Z' },
      { high: 1.2, low: 0.8, time: '2026-07-24T16:00:00.000Z' },
    ] }),
    getOptionHistoryDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200, days: [] }),
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
      getOptionHistoryDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200,
        days: [{ high: 1.6, low: 0.8, close: 1.2 }] }),
      getOptionTimesalesDetailed: async () => {
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
    getOptionHistoryDetailed: async (_symbol, start) => {
      requestedDays.push(start)
      return { ok: true, errorType: null, retryable: false, status: 200, days: [{ high: 1.2, low: 0.8, close: 1 }] }
    },
    getOptionTimesalesDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200, bars: [] }),
  })

  assert.deepEqual(requestedDays, ['2026-07-24'])
  assert.equal(result._stillOpen, true)
})

test('expired row already walked through expiry still fetches settlement close', async () => {
  const requestedDays = []
  const result = await resolver.resolveOne(row({
    expiry_raw: '2026-07-24',
    last_walked_through: '2026-07-24',
  }), {}, {
    now: '2026-07-27T19:00:00.000Z',
    getOptionHistory: async (_symbol, start, end) => {
      requestedDays.push([start, end])
      return [{ high: 1.2, low: 0.8, close: 1.1 }]
    },
    getOptionHistoryDetailed: async () => {
      throw new Error('incremental walk must remain empty')
    },
  })

  assert.deepEqual(requestedDays, [['2026-07-24', '2026-07-24']])
  assert.equal(result.outcome, 'EXPIRED_PARTIAL')
  assert.equal(result.resolution_method, 'expired_partial')
})

// ── Audit Finding 4: real API failures must not silently corrupt the walk cursor ──

test('mid-walk API failure stops the walk and caps the cursor before the failed day, not walkEnd', async () => {
  let calls = 0
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-07-18T15:00:00.000Z', last_walked_through: null, option_type: 'put' }),
    {},
    {
      now: '2026-07-25T15:00:00.000Z',
      getOptionHistoryDetailed: async () => {
        calls++
        if (calls === 3) return { ok: false, errorType: 'RATE_LIMIT', retryable: true, status: 429, days: [] }
        // row()'s defaults: entry_mid=1, target=1.5, stop=0.5 -- stay safely
        // inside that band so Step 1 never indicates a crossing, keeping
        // this test isolated to the failure-handling path being tested
        // (not accidentally exercising the intraday-confirm branch too).
        return { ok: true, errorType: null, retryable: false, status: 200, days: [{ high: 1.1, low: 0.9, close: 1.0 }] }
      },
    },
  )
  assert.equal(result._stillOpen, true)
  assert.equal(result._lastWalkedThrough, '2026-07-21')
  assert.equal(calls, 3) // walk must STOP at the failure, not continue past it
})

test('API failure on the very first day of a walk leaves the cursor untouched (no false progress)', async () => {
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-07-18T15:00:00.000Z', last_walked_through: null }),
    {},
    {
      now: '2026-07-25T15:00:00.000Z',
      getOptionHistoryDetailed: async () => ({ ok: false, errorType: 'SERVER_ERROR', retryable: true, status: 500, days: [] }),
    },
  )
  assert.equal(result._stillOpen, true)
  assert.ok(result._lastWalkedThrough === null || result._lastWalkedThrough === undefined)
})

test('genuine empty response (not a failure) still advances the cursor all the way to walkEnd', async () => {
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-07-18T15:00:00.000Z', last_walked_through: null }),
    {},
    {
      now: '2026-07-25T15:00:00.000Z',
      getOptionHistoryDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200, days: [] }),
    },
  )
  assert.equal(result._stillOpen, true)
  assert.equal(result._lastWalkedThrough, '2026-07-25')
})

test('a real WIN via aged daily-bar fallback still resolves correctly after the failure-handling changes', async () => {
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-06-01T15:00:00.000Z', expiry_raw: '2026-08-01', last_walked_through: '2026-06-02' }),
    {},
    {
      now: '2026-07-25T15:00:00.000Z',
      getOptionHistoryDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200,
        days: [{ high: 4.0, low: 1.9, close: 3.5 }] }),
    },
  )
  assert.equal(result.outcome, 'WIN')
  assert.equal(result.resolution_method, 'daily_bar_fallback_target')
})

// ── Audit Finding 5: session-aware entry-day close time ──

test('entry-day timesales request uses the correct early-close time, not always 16:00', async () => {
  let requestedEnd = null
  await resolver.resolveOne(
    row({ scanned_at: '2026-11-27T15:00:00.000Z', expiry_raw: '2026-12-15' }), // day after Thanksgiving 2026, 13:00 ET close
    {},
    {
      now: '2026-11-27T19:00:00.000Z',
      getOptionTimesalesDetailed: async (_symbol, _start, end) => {
        requestedEnd = end
        return { ok: true, errorType: null, retryable: false, status: 200, bars: [] }
      },
      getOptionHistoryDetailed: async () => ({ ok: true, errorType: null, retryable: false, status: 200, days: [] }),
    },
  )
  assert.equal(requestedEnd, '2026-11-27 13:00')
})

test('after-hours signals skip the invalid entry-day window and begin on the next trading day', async () => {
  const historyDays = []
  let timesalesCalls = 0
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-07-24T20:05:00.000Z' }), // 16:05 ET, after close
    {},
    {
      now: '2026-07-27T19:00:00.000Z',
      getOptionTimesalesDetailed: async () => { timesalesCalls++; return { ok: true, status: 200, bars: [] } },
      getOptionHistoryDetailed: async (_symbol, day) => {
        historyDays.push(day)
        return { ok: true, errorType: null, retryable: false, status: 200, days: [] }
      },
    },
  )
  assert.equal(timesalesCalls, 0)
  assert.deepEqual(historyDays, ['2026-07-27'])
  assert.equal(result._lastWalkedThrough, '2026-07-27')
})

test('premarket signals clamp their entry-day timesales request to 09:30 ET', async () => {
  let requestedStart = null
  await resolver.resolveOne(
    row({ scanned_at: '2026-07-24T12:00:00.000Z' }), // 08:00 ET
    {},
    {
      now: '2026-07-24T19:00:00.000Z',
      getOptionTimesalesDetailed: async (_symbol, start) => {
        requestedStart = start
        return { ok: true, errorType: null, retryable: false, status: 200, bars: [] }
      },
      getOptionHistoryDetailed: async () => ({ ok: true, status: 200, days: [] }),
    },
  )
  assert.equal(requestedStart, '2026-07-24 09:30')
})

test('deterministic HTTP 400 history failures enter capped data-unavailable handling', async () => {
  const result = await resolver.resolveOne(
    row({ scanned_at: '2026-07-20T15:00:00.000Z' }),
    {},
    {
      now: '2026-07-25T15:00:00.000Z',
      getOptionTimesalesDetailed: async () => ({ ok: true, status: 200, bars: [] }),
      getOptionHistoryDetailed: async () => ({
        ok: false, errorType: 'BAD_REQUEST', retryable: false, status: 400, days: [],
      }),
    },
  )
  assert.equal(result._noUsableData, true)
  assert.equal(result._badRequest, true)
})
