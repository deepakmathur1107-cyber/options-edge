const test = require('node:test')
const assert = require('node:assert/strict')
const { collectForwardIvHistory } = require('../api/cron/scan')._test

test('IV collector persists only valid Swing observations using each row timestamp', async () => {
  let written = null
  let options = null
  const client = {
    from(table) {
      assert.equal(table, 'iv_history')
      return {
        upsert: async (rows, value) => {
          written = rows
          options = value
          return { error: null }
        },
      }
    },
  }

  await collectForwardIvHistory(client, [
    { ticker: 'AAPL', timeframe: 'Swing (21–45 DTE)', iv: 0.32, dte_at_signal: 30, scanned_at: '2026-09-11T15:30:00Z' },
    { ticker: 'MSFT', timeframe: 'Quick (5–14 DTE)', iv: 0.40, dte_at_signal: 7, scanned_at: '2026-09-11T15:30:00Z' },
    { ticker: 'NVDA', timeframe: 'Swing (21–45 DTE)', iv: null, dte_at_signal: 28, scanned_at: '2026-09-11T15:30:00Z' },
  ])

  assert.deepEqual(options, { onConflict: 'ticker,date' })
  assert.equal(written.length, 1)
  assert.deepEqual(written[0], {
    ticker: 'AAPL',
    date: '2026-09-11',
    iv_close: 0.32,
    source: 'selected_swing_contract_21_45d',
    dte: 30,
    captured_at: '2026-09-11T15:30:00.000Z',
  })
})

test('IV collector is a no-op when no eligible observation exists', async () => {
  const client = { from() { throw new Error('should not write') } }
  await collectForwardIvHistory(client, [
    { ticker: 'AAPL', timeframe: 'Quick (5–14 DTE)', iv: 0.32, scanned_at: '2026-09-11T15:30:00Z' },
  ])
})
