const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { evaluatePromotion } = require('../_lib/promotionGates')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

async function fetchForwardRows(maxRows = 10_000) {
  const pageSize = 1000
  const rows = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await supabase
      .from('signal_history')
      .select('ticker,sector,outcome,experiment_cohort,scanned_at,resolved_at,realized_r_multiple,estimated_net_pnl_pct,holding_minutes,measurement_version,shadow_strategy_assignments')
      .eq('is_lifecycle_primary', true)
      .eq('strategy_qualified', true)
      .eq('qualification_source', 'LIVE_AT_SIGNAL')
      .eq('market_session_status', 'LIVE_REGULAR_SESSION')
      .order('scanned_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return rows
}

function summarizeShadowStrategies(rows) {
  const summaries = {}
  for (const row of rows) {
    const assignments = row.shadow_strategy_assignments?.assignments || {}
    for (const [strategy, assigned] of Object.entries(assignments)) {
      if (!assigned) continue
      if (!summaries[strategy]) summaries[strategy] = { assigned: 0, resolved: 0, rSum: 0, wins: 0 }
      const bucket = summaries[strategy]
      bucket.assigned++
      if (row.realized_r_multiple != null && Number.isFinite(Number(row.realized_r_multiple))) {
        bucket.resolved++
        bucket.rSum += Number(row.realized_r_multiple)
        if (row.outcome === 'WIN') bucket.wins++
      }
    }
  }
  return Object.entries(summaries).map(([strategy, bucket]) => ({
    strategy,
    assigned: bucket.assigned,
    resolved: bucket.resolved,
    winRate: bucket.resolved ? bucket.wins / bucket.resolved : null,
    expectancyR: bucket.resolved ? bucket.rSum / bucket.resolved : null,
  }))
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { clerkId, isAdmin, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })
  if (!isAdmin && !ADMIN_IDS.includes(clerkId)) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  try {
    const rows = await fetchForwardRows()
    const promotion = evaluatePromotion(rows)
    const measured = rows.filter(row =>
      row.realized_r_multiple != null && Number.isFinite(Number(row.realized_r_multiple)))
    const averageHoldingMinutes = measured.length
      ? measured.reduce((sum, row) => sum + Number(row.holding_minutes || 0), 0) / measured.length
      : null
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      enrolled: rows.length,
      resolvedWithExecutionMetrics: measured.length,
      averageHoldingMinutes,
      promotion,
      shadowStrategies: summarizeShadowStrategies(rows),
      limitations: [
        'Forward-only: historical backfills are excluded.',
        'Shadow strategies do not change displayed recommendations.',
        'Promotion remains blocked until every gate passes.',
      ],
    })
  } catch (error) {
    console.error('[admin/forward-performance] failed:', error.message)
    return res.status(500).json({ error: 'Failed to load forward performance' })
  }
}

module.exports._test = { summarizeShadowStrategies }
