const test = require('node:test')
const assert = require('node:assert/strict')

test('scan decisions separate shortlist, research, watch, and avoid', async () => {
  const { classifyScanDecision } = await import('../src/lib/scanDecision.js')
  assert.equal(classifyScanDecision({ qualityShortlist: { eligible: true } }), 'shortlisted')
  assert.equal(classifyScanDecision({ qualityShortlist: { eligible: false, exclusions: ['PUT_STRATEGY_RESEARCH_ONLY'] } }), 'research')
  assert.equal(classifyScanDecision({ score: 78, qualityShortlist: { eligible: false, exclusions: [] } }), 'watch')
  assert.equal(classifyScanDecision({ score: 95, hardBlocks: ['skip'], qualityShortlist: { eligible: false, exclusions: ['HARD_BLOCK'] } }), 'avoid')
})

test('execution quality and market alignment use contract and dashboard context', async () => {
  const { executionQuality, marketAlignment } = await import('../src/lib/scanDecision.js')
  assert.equal(executionQuality({ bid: 1.96, ask: 2.04, mid: 2, volume: 200, oi: 2000 }).level, 'Excellent')
  assert.equal(executionQuality({ bid: 1.5, ask: 2.5, mid: 2, volume: 10, oi: 100 }).level, 'Poor')
  assert.equal(marketAlignment({ tradeType: 'Long Put', chgPct: '-1.2%' }, 'BEARISH').label, 'WITH MARKET')
  assert.equal(marketAlignment({ tradeType: 'Long Put', chgPct: '-1.2%' }, 'BULLISH').label, 'STOCK-SPECIFIC PUT')
})

test('rejection summary ranks the most common reasons', async () => {
  const { rejectionSummary } = await import('../src/lib/scanDecision.js')
  const summary = rejectionSummary([
    { qualityShortlist: { exclusions: ['POOR_LIQUIDITY', 'EARNINGS'] } },
    { qualityShortlist: { exclusions: ['POOR_LIQUIDITY'] } },
  ])
  assert.deepEqual(summary[0], ['POOR_LIQUIDITY', 2])
})
