const RECENT_RUN_MINUTES = 20

function deriveResolverRunHealth({ runs = [], truePending = 0, cursorStalledRows = 0, terminalDataUnavailable = 0, now = Date.now() }) {
  const states = []
  const latest = runs[0] || null
  const latestFinishedAt = latest?.finished_at || latest?.started_at || null
  const lastRunAgeMinutes = latestFinishedAt
    ? Math.round((now - new Date(latestFinishedAt).getTime()) / 60000)
    : null

  if (!latest) {
    states.push('NO_RUN_TELEMETRY')
  } else if (lastRunAgeMinutes > RECENT_RUN_MINUTES) {
    states.push('NO_RECENT_RESOLVER_RUN')
  } else {
    const recent = runs.slice(0, 3)
    const processed = recent.reduce((sum, run) => sum + Number(run.rows_processed || 0), 0)
    const resolved = recent.reduce((sum, run) => sum + Number(run.resolved || 0), 0)
    const degraded = recent.some(run =>
      run.circuit_broken ||
      Number(run.errors || 0) > 0 ||
      Object.entries(run.status_counts || {}).some(([status, count]) =>
        Number(count) > 0 && (status === '429' || Number(status) >= 500)
      )
    )

    if (degraded) states.push('UPSTREAM_DEGRADED')
    if (truePending > 0 && processed > 0 && resolved === 0) states.push('RESOLVER_NO_PROGRESS')
    if (truePending > 0 && resolved > 0) states.push('HEALTHY_PROCESSING_BACKLOG')
    if (truePending === 0) states.push('HEALTHY_CAUGHT_UP')
  }

  if (cursorStalledRows > 50) states.push('CURSOR_STALLED')
  if (truePending > 0 && terminalDataUnavailable / Math.max(1, truePending + terminalDataUnavailable) > 0.05) {
    states.push('DEAD_LETTER_RATE_HIGH')
  }

  return {
    healthStates: [...new Set(states.length ? states : ['HEALTHY_CAUGHT_UP'])],
    lastRunAgeMinutes,
  }
}

module.exports = { deriveResolverRunHealth, RECENT_RUN_MINUTES }
