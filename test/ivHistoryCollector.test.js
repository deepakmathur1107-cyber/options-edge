const test = require('node:test')
const assert = require('node:assert/strict')
const { collectForwardIvHistory } = require('../api/cron/scan')._test

test('IV collector derives each date from its row and never needs an outer scan timestamp', async () => {
  let written = null
  const client = {
    from(table) {
      assert.equal(table, 'iv_history')
      return { upsert: async rows => { written = rows; return { error: null } } }
    },
  }
  await collectForwardIvHistory(client, [
    { ticker:'AAPL', timeframe:'Swing (21–45 DTE)', iv:0.32, dte_at_signal:30, scanned_at:'2026-09-11T15:30:00Z' },
    { ticker:'MSFT', timeframe:'Quick (5–14 DTE)', iv:0.40, dte_at_signal:7, scanned_at:'2026-09-11T15:30:00Z' },
  ])
  assert.equal(written.length, 1)
  assert.equal(written[0].ticker, 'AAPL')
  assert.equal(written[0].date, '2026-09-11')
  assert.equal(written[0].source, 'selected_swing_contract_21_45d')
})
