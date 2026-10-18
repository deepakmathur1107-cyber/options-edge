const test = require('node:test')
const assert = require('node:assert/strict')
const { runCreditOpen, weekdayBucket, weekdayIndex } = require('../api/cron/credit-shadow-open')._test
const { runCreditManage, quoteTradeDate } = require('../api/cron/credit-shadow-manage')._test

const TODAY = '2026-10-19' // Monday

function put(ticker, strike, bid, ask, delta) {
  return { symbol: `${ticker}P${strike}`, option_type: 'put', strike, bid, ask, greeks: { delta: -delta, mid_iv: 0.2 } }
}
function call(ticker, strike, bid, ask, delta) {
  return { symbol: `${ticker}C${strike}`, option_type: 'call', strike, bid, ask, greeks: { delta, mid_iv: 0.2 } }
}
function chainFor(ticker) {
  return [
    put(ticker, 85, 2.80, 2.82, 0.27),
    put(ticker, 86, 3.10, 3.12, 0.29),
    call(ticker, 114, 3.10, 3.12, 0.29),
    call(ticker, 115, 2.80, 2.82, 0.27),
  ]
}

function fakeOpenDeps(overrides = {}) {
  const inserted = []
  const deps = {
    loadWeekKeys: async () => new Set(),
    loadStockUniverse: async () => [],
    loadTodaySwingSignals: async () => [],
    loadEarnings: async () => new Map(),
    getQuotes: async symbols => new Map(symbols.map(s => [s, { symbol: s, last: 100 }])),
    getTrend: async () => ({ direction: 'bullish', sma200: 90 }),
    getExpiries: async () => ['2026-11-27'],
    getChain: async ticker => chainFor(ticker),
    insertPosition: async row => { inserted.push(row); return { inserted: true, error: null } },
    ...overrides,
  }
  return { deps, inserted }
}

const tracker = () => ({ calls: 0, minAvailable: null })

test('weekday buckets are stable and cover Monday to Friday', () => {
  assert.equal(weekdayIndex('2026-10-19'), 0)
  assert.equal(weekdayIndex('2026-10-23'), 4)
  for (const t of ['AAPL', 'MSFT', 'NVDA', 'JPM', 'XOM']) {
    const b = weekdayBucket(t)
    assert.ok(b >= 0 && b <= 4)
    assert.equal(weekdayBucket(t), b)
  }
})

test('opens all four index ETFs with the side set by the 200-day SMA', async () => {
  const { deps, inserted } = fakeOpenDeps({
    getTrend: async t => ({ direction: 'mixed', sma200: t === 'IWM' ? 110 : 90 }),
  })
  const result = await runCreditOpen({ today: TODAY, deps, tracker: tracker() })
  assert.equal(result.opened.length, 4)
  const iwm = inserted.find(r => r.ticker === 'IWM')
  assert.equal(iwm.side, 'BEAR_CALL')
  assert.equal(iwm.trend_at_entry, 'below_sma200')
  const spy = inserted.find(r => r.ticker === 'SPY')
  assert.equal(spy.side, 'BULL_PUT')
  assert.equal(spy.entry_week, '2026-10-19')
  assert.equal(spy.dte_at_entry, 39)
  assert.ok(inserted.every(r => r.arm === 'A_INDEX' && r.strategy_version === 'swing_credit_spread_managed_v1'))
})

test('skips arm/ticker pairs already opened this week', async () => {
  const { deps } = fakeOpenDeps({ loadWeekKeys: async () => new Set(['A_INDEX|SPY', 'A_INDEX|QQQ']) })
  const result = await runCreditOpen({ today: TODAY, deps, tracker: tracker() })
  assert.equal(result.opened.length, 2)
  assert.equal(result.tally.ALREADY_OPEN_THIS_WEEK, 2)
})

test('arm B only evaluates the day bucket, only bullish names, and skips earnings', async () => {
  const names = ['AAPL', 'MSFT', 'NVDA', 'JPM', 'XOM', 'COST', 'LLY', 'AVGO', 'HD', 'KO']
  const mondayNames = names.filter(t => weekdayBucket(t) === 0)
  assert.ok(mondayNames.length >= 1, 'fixture needs at least one Monday name')
  const earningsName = mondayNames[0]
  const { deps, inserted } = fakeOpenDeps({
    loadStockUniverse: async () => names,
    loadEarnings: async () => new Map([[earningsName, '2026-11-05']]),
    getTrend: async t => ({ direction: t === 'MSFT' ? 'bearish' : 'bullish', sma200: 90 }),
  })
  const result = await runCreditOpen({ today: TODAY, deps, tracker: tracker() })
  const armB = inserted.filter(r => r.arm === 'B_STOCK').map(r => r.ticker)
  assert.ok(armB.every(t => weekdayBucket(t) === 0))
  assert.ok(!armB.includes(earningsName))
  assert.ok(!armB.includes('MSFT'))
  assert.ok(armB.every(t => inserted.find(r => r.ticker === t && r.arm === 'B_STOCK').side === 'BULL_PUT'))
  assert.equal(result.tally.EARNINGS_BEFORE_EXPIRY, 1)
})

test('arm C follows the signal direction and records the source signal', async () => {
  const { deps, inserted } = fakeOpenDeps({
    loadTodaySwingSignals: async () => [{ id: 42, ticker: 'AMD', option_type: 'put', score: 81 }],
  })
  await runCreditOpen({ today: TODAY, deps, tracker: tracker() })
  const c = inserted.find(r => r.arm === 'C_SIGNAL')
  assert.equal(c.side, 'BEAR_CALL')
  assert.equal(c.source_signal_id, 42)
  assert.equal(c.trend_at_entry, null)
})

test('stops calling Tradier when the shared rate headroom is low', async () => {
  const { deps, inserted } = fakeOpenDeps()
  const result = await runCreditOpen({ today: TODAY, deps, tracker: { calls: 0, minAvailable: 5 } })
  assert.equal(inserted.length, 0)
  assert.equal(result.circuitBroken, true)
  assert.equal(result.tally.SKIPPED_BUDGET, 4)
})

const openPosition = {
  id: 1, ticker: 'SPY', side: 'BULL_PUT', short_strike: 86, long_strike: 85, width: 1,
  short_symbol: 'SPYP86', long_symbol: 'SPYP85', entry_credit_natural: 0.28, max_loss: 0.72,
  expiry: '2026-11-27', entry_at: '2026-10-19T14:31:00Z', daily_marks: [], missing_mark_days: 0,
  last_marked_date: null,
}
const sessionToday = date => ({ symbol: 'SPY', last: 100, trade_date: Date.parse(`${date}T19:44:00Z`) })

function fakeManageDeps(positions, quoteList, extra = {}) {
  const updates = []
  return {
    updates,
    deps: {
      loadOpenPositions: async () => positions,
      getQuotes: async () => new Map(quoteList.map(q => [q.symbol, q])),
      getCloseOn: async () => null,
      updatePosition: async (id, update) => { updates.push({ id, update }); return { error: null } },
      ...extra,
    },
  }
}

test('quoteTradeDate converts epoch milliseconds to the New York date', () => {
  assert.equal(quoteTradeDate({ trade_date: Date.parse('2026-11-02T19:44:00Z') }), '2026-11-02')
  assert.equal(quoteTradeDate({}), null)
})

test('closes at take profit and records P&L', async () => {
  const today = '2026-11-02'
  const { deps, updates } = fakeManageDeps([openPosition], [
    sessionToday(today),
    { symbol: 'SPYP86', bid: 0.10, ask: 0.12 },
    { symbol: 'SPYP85', bid: 0.04, ask: 0.05 },
  ])
  const result = await runCreditManage({ today, deps })
  assert.equal(result.tally.CLOSED_TAKE_PROFIT, 1)
  const u = updates[0].update
  assert.equal(u.status, 'CLOSED')
  assert.equal(u.exit_debit_natural, 0.08)
  assert.equal(u.net_pnl_dollars, 17.4) // (0.28-0.08)*100 - 2.60
  assert.equal(u.days_held, 14)
  assert.equal(u.daily_marks.length, 1)
})

test('holds and appends a mark when no rule fires', async () => {
  const today = '2026-11-02'
  const { deps, updates } = fakeManageDeps([openPosition], [
    sessionToday(today),
    { symbol: 'SPYP86', bid: 0.30, ask: 0.32 },
    { symbol: 'SPYP85', bid: 0.10, ask: 0.11 },
  ])
  const result = await runCreditManage({ today, deps })
  assert.equal(result.tally.HOLD, 1)
  assert.equal(updates[0].update.status, undefined)
  assert.equal(updates[0].update.last_marked_date, today)
})

test('does nothing without a confirmed session today', async () => {
  const { deps, updates } = fakeManageDeps([openPosition], [sessionToday('2026-10-30')])
  const result = await runCreditManage({ today: '2026-11-02', deps })
  assert.equal(result.sessionConfirmed, false)
  assert.equal(updates.length, 0)
})

test('a missed expiry settles on the expiry-date close, not today', async () => {
  const today = '2026-11-30'
  const { deps, updates } = fakeManageDeps([openPosition], [sessionToday(today)], {
    getCloseOn: async (ticker, date) => (date === '2026-11-27' ? 85.5 : null),
  })
  const result = await runCreditManage({ today, deps })
  assert.equal(result.tally.CLOSED_EXPIRY, 1)
  const u = updates[0].update
  assert.equal(u.exit_debit_natural, 0.5)
  assert.equal(u.days_held, 39)
})

test('skips positions already marked today', async () => {
  const today = '2026-11-02'
  const { deps, updates } = fakeManageDeps([{ ...openPosition, last_marked_date: today }], [sessionToday(today)])
  const result = await runCreditManage({ today, deps })
  assert.equal(result.due, 0)
  assert.equal(updates.length, 0)
})
