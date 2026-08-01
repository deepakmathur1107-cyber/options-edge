const test = require('node:test')
const assert = require('node:assert/strict')
const { calculateDmiVolumeConfirmation } = require('../api/_lib/dmiVolumeConfirmation')

function trendBars(direction = 1, count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const acceleration = index > 55 ? (index - 55) * 0.12 : 0
    const close = 100 + direction * (index * 0.35 + acceleration)
    return { date: `bar-${index}`, close, high: close + 1, low: close - 1, volume: 1_000_000 + index * 15_000 }
  })
}

test('measures bullish DMI, volume MACD, and VZO confirmation', () => {
  const result = calculateDmiVolumeConfirmation(trendBars(1))
  assert.equal(result.status, 'MEASURED')
  assert.ok(result.plus_di > result.minus_di)
  assert.ok(result.vzo > 0)
  assert.equal(result.bullish_confirmed, true)
})

test('recognizes the mirrored bearish confirmation', () => {
  const result = calculateDmiVolumeConfirmation(trendBars(-1))
  assert.equal(result.status, 'MEASURED')
  assert.ok(result.minus_di > result.plus_di)
  assert.ok(result.vzo < 0)
  assert.equal(result.bearish_confirmed, true)
})

test('fails closed when there are not enough bars', () => {
  assert.equal(calculateDmiVolumeConfirmation(trendBars(1, 10)).status, 'INSUFFICIENT_DATA')
})
