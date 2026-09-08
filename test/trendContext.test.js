const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyWeeklyTrend } = require('../api/_lib/trendContext')

function weekdayBars(count, direction = 1) {
  const bars = []
  const date = new Date('2025-01-06T12:00:00Z')
  while (bars.length < count) {
    const day = date.getUTCDay()
    if (day !== 0 && day !== 6) {
      bars.push({ date: date.toISOString().slice(0, 10), close: 100 + direction * bars.length })
    }
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return bars
}

test('classifies weekly direction from point-in-time daily history', () => {
  assert.equal(classifyWeeklyTrend(weekdayBars(230, 1)).direction, 'bullish')
  assert.equal(classifyWeeklyTrend(weekdayBars(230, -0.2)).direction, 'bearish')
})
