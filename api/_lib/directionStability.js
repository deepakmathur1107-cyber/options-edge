const LOOKBACK_HOURS = 8
const RECENT_FLIP_MINUTES = 90

function sideOf(row = {}) {
  const explicit = String(row.option_type || '').toLowerCase()
  if (explicit === 'call' || explicit === 'put') return explicit
  const tradeType = String(row.trade_type || '').toLowerCase()
  if (tradeType.includes('call')) return 'call'
  if (tradeType.includes('put')) return 'put'
  return null
}

function timestampOf(row = {}) {
  const value = row.scanned_at || row.created_at
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

function isLoss(outcome) {
  return String(outcome || '').toUpperCase() === 'LOSS'
}

function buildDirectionStability(current, observations = [], options = {}) {
  const currentSide = sideOf(current)
  const currentTime = timestampOf(current)
  const maxMinutes = options.recentFlipMinutes || RECENT_FLIP_MINUTES
  if (!currentSide || currentTime == null) return { status: 'UNKNOWN', eligible: false }

  const relevant = observations
    .filter(row => row.ticker === current.ticker && row.timeframe === current.timeframe)
    .map(row => ({ ...row, _side: sideOf(row), _time: timestampOf(row) }))
    .filter(row => row._side && row._time != null)
    .sort((a, b) => b._time - a._time)

  const opposing = relevant.find(row => row._side !== currentSide && row._time <= currentTime)
  if (!opposing) return { status: 'STABLE', eligible: true, current_side: currentSide }

  const minutesSinceOpposing = Math.round((currentTime - opposing._time) / 60000)
  if (minutesSinceOpposing > maxMinutes) return {
    status: 'STABLE', eligible: true, current_side: currentSide,
    last_opposing_side: opposing._side, minutes_since_opposing: minutesSinceOpposing,
  }

  const lifecycleOutcomes = new Map()
  for (const row of relevant) {
    if (row.signal_lifecycle_id && row.outcome) lifecycleOutcomes.set(row.signal_lifecycle_id, row.outcome)
  }
  const currentLifecycle = current.signal_lifecycle_id
  const opposingLifecycle = opposing.signal_lifecycle_id
  const bothSidesFailed = Boolean(
    currentLifecycle && opposingLifecycle && currentLifecycle !== opposingLifecycle
    && isLoss(lifecycleOutcomes.get(currentLifecycle))
    && isLoss(lifecycleOutcomes.get(opposingLifecycle))
  )

  return {
    status: bothSidesFailed ? 'BOTH_SIDES_FAILED' : 'DIRECTION_CHANGED',
    eligible: false,
    current_side: currentSide,
    previous_side: opposing._side,
    minutes_between: minutesSinceOpposing,
    current_lifecycle_id: currentLifecycle || null,
    previous_lifecycle_id: opposingLifecycle || null,
    both_sides_failed: bothSidesFailed,
    message: bothSidesFailed
      ? `Both ${opposing._side} and ${currentSide} directions resolved as losses.`
      : `Direction changed from ${opposing._side} to ${currentSide} ${minutesSinceOpposing} minutes apart. Wait for confirmation.`,
  }
}

async function attachDirectionStability(client, rows) {
  if (!rows || !rows.length) return rows
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const groups = new Map()
  for (const row of rows) {
    if (!row.ticker || !row.timeframe) continue
    if (!groups.has(row.timeframe)) groups.set(row.timeframe, new Set())
    groups.get(row.timeframe).add(row.ticker)
  }

  const observations = []
  await Promise.all([...groups.entries()].map(async ([timeframe, tickers]) => {
    const { data, error } = await client
      .from('signal_history')
      .select('ticker,timeframe,option_type,trade_type,scanned_at,created_at,signal_lifecycle_id,outcome')
      .eq('timeframe', timeframe)
      .in('ticker', [...tickers])
      .gte('scanned_at', cutoff)
      .order('scanned_at', { ascending: false })
      .limit(1000)
    if (error) {
      console.error('[directionStability] history fetch failed (non-fatal):', error.message)
      return
    }
    observations.push(...(data || []))
  }))

  for (const row of rows) row.direction_stability = buildDirectionStability(row, observations)
  return rows
}

module.exports = { LOOKBACK_HOURS, RECENT_FLIP_MINUTES, buildDirectionStability, attachDirectionStability }
