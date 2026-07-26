// api/_lib/lifecycleSummary.js
//
// Phase A of the conviction-transparency plan (2026-07-08 session): a signal
// card currently shows one static score with no sense of trajectory — a
// setup that just hit 95 for the first time looks identical to one that's
// been pinned at 95 for three hours while its own premium quietly fell.
// Confirmed live on META $595P 2026-07-08: score climbed 84->95 over ~2.5h
// while entry_mid fell from $6.48 to $5.58 (~14%) and the underlying stayed
// rangebound — the score was being held up mainly by cumulative volume
// crossing a threshold (which rises mechanically through any trading day),
// not by fresh price confirmation. This module makes that visible instead
// of requiring someone to manually reconstruct it from raw signal_history
// rows, which is how that META case was actually caught.
//
// Read-only. Computes from signal_history rows that already exist — no new
// data collection, no change to scoring or scan_results writes.

// Untuned starting point, not derived from validated data — same caveat as
// every other threshold introduced this session (concentration flag, etc.):
// revisit once there's real evidence on what divergence magnitude actually
// predicts a stalled/deteriorating setup vs. normal noise.
const DIVERGENCE_PREMIUM_DROP_PCT = 0.08   // premium down >=8% from first scan
const DIVERGENCE_MIN_ELAPSED_MIN  = 30     // ignore noise in the first 30 min

function classifyLifecycle(primary) {
  if (!primary) return { status: 'TRACKING', measurement: 'NOT_ENROLLED' }
  if (primary.resolved_at || primary.outcome) {
    if (primary.resolution_method === 'data_unavailable') {
      return { status: 'DATA_UNAVAILABLE', measurement: 'EXCLUDED' }
    }
    return { status: 'RESOLVED', measurement: primary.realized_r_multiple == null ? 'PENDING_METRICS' : 'MEASURED' }
  }
  const isForwardLive = primary.qualification_source === 'LIVE_AT_SIGNAL'
    && primary.market_session_status === 'LIVE_REGULAR_SESSION'
  if (!isForwardLive) return { status: 'RESEARCH', measurement: 'EXCLUDED' }
  if (primary.strategy_qualified) return { status: 'LIVE', measurement: 'FORWARD_COHORT' }
  return { status: 'TRACKING', measurement: 'NOT_QUALIFIED' }
}

/**
 * Batch-fetch signal_history rows for a set of lifecycle IDs and compute a
 * summary per lifecycle. One query for the whole set, not one per row.
 *
 * @param {object} client - Supabase client
 * @param {string[]} lifecycleIds - unique signal_lifecycle_id values to summarize
 * @returns {Promise<Map<string, object>>} lifecycleId -> summary
 */
async function getLifecycleSummaries(client, lifecycleIds) {
  const ids = [...new Set((lifecycleIds || []).filter(Boolean))]
  const summaries = new Map()
  if (!ids.length) return summaries

  const { data: rows, error } = await client
    .from('signal_history')
    .select('signal_lifecycle_id, score, entry_mid, underlying_price, scanned_at, is_lifecycle_primary, outcome, resolved_at, resolution_method, realized_r_multiple, qualification_source, market_session_status, strategy_qualified')
    .in('signal_lifecycle_id', ids)
    .order('scanned_at', { ascending: true })

  if (error) {
    console.error('[lifecycleSummary] batch fetch failed (non-fatal, cards render without trajectory):', error.message)
    return summaries
  }

  const byLifecycle = new Map()
  for (const row of rows || []) {
    const key = row.signal_lifecycle_id
    if (!byLifecycle.has(key)) byLifecycle.set(key, [])
    byLifecycle.get(key).push(row)
  }

  for (const [id, history] of byLifecycle.entries()) {
    if (!history.length) continue
    const first  = history[0]
    const latest = history[history.length - 1]
    const primary = history.find(row => row.is_lifecycle_primary) || first
    const lifecycle = classifyLifecycle(primary)

    const firstScore  = Number(first.score)
    const latestScore = Number(latest.score)
    const firstMid    = parseFloat(first.entry_mid)
    const latestMid    = parseFloat(latest.entry_mid)
    const elapsedMin   = Math.round((new Date(latest.scanned_at) - new Date(first.scanned_at)) / 60000)

    const scoreDelta     = Number.isFinite(firstScore) && Number.isFinite(latestScore) ? latestScore - firstScore : null
    const premiumDeltaPct = Number.isFinite(firstMid) && firstMid > 0 && Number.isFinite(latestMid)
      ? (latestMid - firstMid) / firstMid
      : null

    // Divergence: score flat-or-rising while premium has fallen meaningfully
    // since the setup first appeared. This is the exact pattern that made
    // META's 95 look far fresher than it actually was.
    const divergence = scoreDelta !== null && premiumDeltaPct !== null
      && scoreDelta >= 0
      && premiumDeltaPct <= -DIVERGENCE_PREMIUM_DROP_PCT
      && elapsedMin >= DIVERGENCE_MIN_ELAPSED_MIN

    summaries.set(id, {
      first_score: firstScore,
      first_entry_mid: firstMid,
      first_scanned_at: first.scanned_at,
      latest_score: latestScore,
      latest_entry_mid: latestMid,
      num_scans: history.length,
      elapsed_minutes: elapsedMin,
      score_delta: scoreDelta,
      premium_delta_pct: premiumDeltaPct,
      divergence,
      lifecycle_status: lifecycle.status,
      measurement_status: lifecycle.measurement,
    })
  }

  return summaries
}

/**
 * Attach a `lifecycle_summary` field to each scan_results row in place.
 * Rows with no signal_lifecycle_id (shouldn't happen post-migration, but
 * defensive for any stale cached rows written before the column existed)
 * are left with lifecycle_summary: null rather than failing the request.
 */
async function attachLifecycleSummaries(client, rows) {
  if (!rows || !rows.length) return rows
  const ids = rows.map(r => r.signal_lifecycle_id).filter(Boolean)
  const summaries = await getLifecycleSummaries(client, ids)
  for (const row of rows) {
    row.lifecycle_summary = row.signal_lifecycle_id
      ? (summaries.get(row.signal_lifecycle_id) || null)
      : null
  }
  return rows
}

module.exports = { getLifecycleSummaries, attachLifecycleSummaries, classifyLifecycle }
