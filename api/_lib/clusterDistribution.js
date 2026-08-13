const RUN_GAP_MS = 7 * 60 * 1000

// signal_history predates explicit scan run IDs. Reconstruct runs separately
// per timeframe: cron runs are 15+ minutes apart while observations within a
// run are emitted continuously for at most a few minutes.
function buildClusterDistribution(rows, minSize) {
  const byTimeframe = new Map()
  for (const row of rows || []) {
    if (!row.scanned_at || !row.timeframe || !row.sector || !row.ticker) continue
    if (!byTimeframe.has(row.timeframe)) byTimeframe.set(row.timeframe, [])
    byTimeframe.get(row.timeframe).push(row)
  }

  const clusters = []
  let runCount = 0
  for (const [timeframe, timeframeRows] of byTimeframe) {
    timeframeRows.sort((a, b) => new Date(a.scanned_at) - new Date(b.scanned_at))
    let run = []
    let previousAt = null
    const flush = () => {
      if (!run.length) return
      runCount++
      const groups = new Map()
      for (const row of run) {
        const direction = row.option_type === 'put' ? 'put' : row.option_type === 'call' ? 'call' : null
        if (!direction) continue
        const key = `${row.sector}|${direction}`
        if (!groups.has(key)) groups.set(key, { sector: row.sector, direction, tickers: new Set() })
        groups.get(key).tickers.add(row.ticker)
      }
      for (const group of groups.values()) {
        if (group.tickers.size >= minSize) clusters.push({
          runAt: run[0].scanned_at,
          timeframe,
          sector: group.sector,
          direction: group.direction,
          clusterSize: group.tickers.size,
        })
      }
      run = []
    }
    for (const row of timeframeRows) {
      const at = new Date(row.scanned_at).getTime()
      if (previousAt !== null && at - previousAt > RUN_GAP_MS) flush()
      run.push(row)
      previousAt = at
    }
    flush()
  }

  clusters.sort((a, b) => b.runAt.localeCompare(a.runAt) || b.clusterSize - a.clusterSize)
  return { clusters, runCount }
}

module.exports = { buildClusterDistribution, RUN_GAP_MS }
