const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyOptionMarketSession, isActionableOptionSession } = require('../api/_lib/marketCalendar')

test('classifies regular, premarket, late, and after-hours option observations in New York time', () => {
  assert.equal(classifyOptionMarketSession('2026-07-27T13:29:00.000Z'), 'PREMARKET_RESEARCH')
  assert.equal(classifyOptionMarketSession('2026-07-27T13:30:00.000Z'), 'LIVE_REGULAR_SESSION')
  assert.equal(classifyOptionMarketSession('2026-07-27T19:44:00.000Z'), 'LIVE_REGULAR_SESSION')
  assert.equal(classifyOptionMarketSession('2026-07-27T19:45:00.000Z'), 'LATE_SESSION_RESEARCH')
  assert.equal(classifyOptionMarketSession('2026-07-27T20:00:00.000Z'), 'AFTER_HOURS_RESEARCH')
  assert.equal(isActionableOptionSession('2026-07-27T19:44:00.000Z'), true)
  assert.equal(isActionableOptionSession('2026-07-27T19:45:00.000Z'), false)
})

test('weekends and holidays are research-only', () => {
  assert.equal(classifyOptionMarketSession('2026-07-26T15:00:00.000Z'), 'WEEKEND_RESEARCH')
  assert.equal(classifyOptionMarketSession('2026-07-03T15:00:00.000Z'), 'HOLIDAY_RESEARCH')
})

test('standard early close applies the same 15-minute execution buffer', () => {
  assert.equal(classifyOptionMarketSession('2026-11-27T17:44:00.000Z'), 'LIVE_REGULAR_SESSION')
  assert.equal(classifyOptionMarketSession('2026-11-27T17:45:00.000Z'), 'LATE_SESSION_RESEARCH')
  assert.equal(classifyOptionMarketSession('2026-11-27T18:00:00.000Z'), 'AFTER_HOURS_RESEARCH')
})
