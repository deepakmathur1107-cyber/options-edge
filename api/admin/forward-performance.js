const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { evaluatePromotion } = require('../_lib/promotionGates')

let _supabase = null
function sb() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  }
  return _supabase
}

async function fetchForwardRows(maxRows = 10_000) {
  const pageSize = 1000
  const rows = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await sb()
      .from('signal_history')
      .select('ticker,sector,outcome,experiment_cohort,scanned_at,resolved_at,realized_r_multiple,estimated_net_pnl_pct,holding_minutes,measurement_version,shadow_strategy_assignments,shadow_spread_outcome,shadow_spread_pnl_pct,shortened_hold_outcome,shortened_hold_pnl_pct')
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
      if (!summaries[strategy]) summaries[strategy] = { assigned: 0, observations: [], tickers: new Map(), days: new Set() }
      const bucket = summaries[strategy]
      bucket.assigned++
      bucket.days.add(String(row.scanned_at || '').slice(0, 10))
      bucket.tickers.set(row.ticker, (bucket.tickers.get(row.ticker) || 0) + 1)
      if (strategy === 'defined_risk_spread_v2e') {
        if (row.shadow_spread_pnl_pct != null && Number.isFinite(Number(row.shadow_spread_pnl_pct))) {
          bucket.observations.push({ value: Number(row.shadow_spread_pnl_pct) / 100, win: Number(row.shadow_spread_pnl_pct) > 0 })
        }
      } else if (row.realized_r_multiple != null && Number.isFinite(Number(row.realized_r_multiple))) {
        bucket.observations.push({ value: Number(row.realized_r_multiple), win: Number(row.realized_r_multiple) > 0 })
      }
    }
  }
  return Object.entries(summaries).map(([strategy, bucket]) => {
    const resolved = bucket.observations.length
    const values = bucket.observations.map(item => item.value)
    const wins = bucket.observations.filter(item => item.win).length
    const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0)
    const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0))
    const maximumTickerCount = Math.max(0, ...bucket.tickers.values())
    const actualSpread = strategy === 'defined_risk_spread_v2e'
    const cohortDays = [...bucket.days].filter(Boolean).length
    return {
      strategy,
      assigned: bucket.assigned,
      resolved,
      winRate: resolved ? wins / resolved : null,
      expectancyR: !actualSpread && resolved ? values.reduce((sum, value) => sum + value, 0) / resolved : null,
      averageReturnPct: actualSpread && resolved ? 100 * values.reduce((sum, value) => sum + value, 0) / resolved : null,
      profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : 0,
      cohortDays,
      tickerCount: bucket.tickers.size,
      maximumTickerShare: bucket.assigned ? maximumTickerCount / bucket.assigned : null,
      measurementBasis: actualSpread ? 'ACTUAL_SPREAD_SETTLEMENT' : 'EXECUTION_ADJUSTED_SINGLE_LEG_R',
      evidenceStatus: resolved < 30 ? 'EARLY_SAMPLE' : cohortDays < 3 ? 'NEEDS_MORE_COHORTS' : 'RESEARCH_EVIDENCE_AVAILABLE',
    }
  })
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
      shadowMeasurementCoverage: {
        spreadSettlements: rows.filter(row => row.shadow_spread_pnl_pct != null && Number.isFinite(Number(row.shadow_spread_pnl_pct))).length,
        shortenedHoldResults: rows.filter(row => row.shortened_hold_pnl_pct != null && Number.isFinite(Number(row.shortened_hold_pnl_pct))).length,
      },
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
