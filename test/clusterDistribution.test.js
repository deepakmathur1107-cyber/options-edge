const test = require('node:test')
const assert = require('node:assert/strict')
const { buildClusterDistribution } = require('../api/_lib/clusterDistribution')

const row = (minute, timeframe, ticker, sector = 'Technology', option_type = 'call') => ({
  scanned_at: `2026-08-13T14:${String(minute).padStart(2, '0')}:00.000Z`, timeframe, ticker, sector, option_type,
})

test('reconstructs clusters within one timeframe and scanner run', () => {
  const result = buildClusterDistribution([
    row(0, 'Quick', 'A'), row(1, 'Quick', 'B'), row(2, 'Quick', 'C'), row(3, 'Quick', 'D'),
  ], 3)
  assert.equal(result.runCount, 1)
  assert.equal(result.clusters.length, 1)
  assert.equal(result.clusters[0].clusterSize, 4)
})

test('does not pool timeframes or scanner runs', () => {
  const result = buildClusterDistribution([
    row(0, 'Quick', 'A'), row(1, 'Quick', 'B'), row(2, 'Swing', 'C'), row(3, 'Swing', 'D'),
    row(15, 'Quick', 'C'), row(16, 'Quick', 'D'),
  ], 3)
  assert.equal(result.runCount, 3)
  assert.equal(result.clusters.length, 0)
})

test('counts repeated ticker observations once inside a reconstructed run', () => {
  const result = buildClusterDistribution([
    row(0, 'Quick', 'A'), row(1, 'Quick', 'A'), row(2, 'Quick', 'B'), row(3, 'Quick', 'C'),
  ], 3)
  assert.equal(result.clusters[0].clusterSize, 3)
})
