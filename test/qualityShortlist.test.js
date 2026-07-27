const test = require('node:test')
const assert = require('node:assert/strict')
const { buildQualityShortlistDecision } = require('../api/_lib/qualityShortlist')

const clean = {
  score: 92,
  bid: '$0.94',
  ask: '$0.96',
  mid: '$0.95',
  volume: 1970,
  oi: 4045,
  hard_blocks: [],
  warnings: [],
}

test('admits a liquid, high-score setup with no material warnings', () => {
  const result = buildQualityShortlistDecision(clean)
  assert.equal(result.eligible, true)
  assert.deepEqual(result.exclusions, [])
  assert.equal(result.metrics.spreadPct, 2.11)
})

test('rejects opening-window, correlated, earnings, and weak-volume setups', () => {
  const result = buildQualityShortlistDecision({
    ...clean,
    warnings: [
      'MARKET OPEN — First 30 min are volatile',
      'Earnings in 2d — IV crush risk',
      'Low volume 0.5x — weak conviction',
      '80% of signals are calls — correlated market-wide bet',
    ],
  })
  assert.equal(result.eligible, false)
  assert.deepEqual(result.exclusions, [
    'OPENING_WINDOW',
    'EARNINGS_RISK',
    'RELATIVE_VOLUME_WEAK',
    'DIRECTION_CONCENTRATED',
  ])
})

test('rejects wide spreads, insufficient liquidity, and hard blocks', () => {
  const result = buildQualityShortlistDecision({
    ...clean,
    bid: '$0.80',
    ask: '$1.10',
    volume: 20,
    oi: 100,
    hard_blocks: ['Skip'],
  })
  assert.equal(result.eligible, false)
  assert.ok(result.exclusions.includes('HARD_BLOCK'))
  assert.ok(result.exclusions.includes('SPREAD_ABOVE_8_PCT'))
  assert.ok(result.exclusions.includes('VOLUME_BELOW_100'))
  assert.ok(result.exclusions.includes('OPEN_INTEREST_BELOW_500'))
})

test('does not alter Qualified V1 or any trading decision fields', () => {
  const row = { ...clean, strategy_qualified: true, strategy_version: 'swing_call_v1' }
  const result = buildQualityShortlistDecision(row)
  assert.equal(result.eligible, true)
  assert.equal(row.strategy_qualified, true)
  assert.equal(row.strategy_version, 'swing_call_v1')
})
