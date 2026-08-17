const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { evaluatePromotion } = require('../_lib/promotionGates')
const { summarizeReturns, evaluateProfitabilityGate } = require('../_lib/oeProfitability')

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
      .select('ticker,sector,timeframe,option_type,outcome,experiment_cohort,scanned_at,resolved_at,realized_r_multiple,estimated_net_pnl_pct,holding_minutes,measurement_version,theta,gamma,vega,expected_move_pct,breakeven_expected_move_ratio,entry_spread_pct,shadow_strategy_assignments,shadow_spread_outcome,shadow_spread_pnl_pct,shortened_hold_outcome,shortened_hold_pnl_pct')
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
  const addObservation = (bucket, group, value) => {
    if (!Number.isFinite(value)) return
    bucket[group].push({ value, win: value > 0 })
  }
  const metrics = observations => {
    const values = observations.map(item => item.value)
    const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0)
    const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0))
    return {
      resolved: values.length,
      winRate: values.length ? observations.filter(item => item.win).length / values.length : null,
      expectancy: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : 0,
    }
  }
  for (const row of rows) {
    const assignments = row.shadow_strategy_assignments?.assignments || {}
    for (const [strategy, assigned] of Object.entries(assignments)) {
      if (!summaries[strategy]) summaries[strategy] = { assigned: 0, excluded: 0, selected: [], rejected: [], tickers: new Map(), days: new Set() }
      const bucket = summaries[strategy]
      const group = assigned ? 'selected' : 'rejected'
      if (assigned) {
        bucket.assigned++
        bucket.days.add(String(row.scanned_at || '').slice(0, 10))
        bucket.tickers.set(row.ticker, (bucket.tickers.get(row.ticker) || 0) + 1)
      } else bucket.excluded++
      if (strategy === 'defined_risk_spread_v2e') {
        if (assigned && row.shadow_spread_pnl_pct != null) addObservation(bucket, group, Number(row.shadow_spread_pnl_pct) / 100)
      } else if (row.realized_r_multiple != null) addObservation(bucket, group, Number(row.realized_r_multiple))
    }
  }
  return Object.entries(summaries).map(([strategy, bucket]) => {
    const selected = metrics(bucket.selected)
    const rejected = metrics(bucket.rejected)
    const maximumTickerCount = Math.max(0, ...bucket.tickers.values())
    const actualSpread = strategy === 'defined_risk_spread_v2e'
    const cohortDays = [...bucket.days].filter(Boolean).length
    return {
      strategy,
      assigned: bucket.assigned,
      excluded: bucket.excluded,
      resolved: selected.resolved,
      winRate: selected.winRate,
      expectancyR: !actualSpread ? selected.expectancy : null,
      averageReturnPct: actualSpread && selected.expectancy != null ? 100 * selected.expectancy : null,
      profitFactor: selected.profitFactor,
      rejectedResolved: actualSpread ? 0 : rejected.resolved,
      rejectedWinRate: actualSpread ? null : rejected.winRate,
      rejectedExpectancyR: actualSpread ? null : rejected.expectancy,
      rejectedProfitFactor: actualSpread ? null : rejected.profitFactor,
      expectancyLiftR: !actualSpread && selected.expectancy != null && rejected.expectancy != null
        ? selected.expectancy - rejected.expectancy
        : null,
      cohortDays,
      tickerCount: bucket.tickers.size,
      maximumTickerShare: bucket.assigned ? maximumTickerCount / bucket.assigned : null,
      measurementBasis: actualSpread ? 'ACTUAL_SPREAD_SETTLEMENT' : 'EXECUTION_ADJUSTED_SINGLE_LEG_R',
      evidenceStatus: selected.resolved < 30 ? 'EARLY_SAMPLE' : cohortDays < 3 ? 'NEEDS_MORE_COHORTS' : 'RESEARCH_EVIDENCE_AVAILABLE',
    }
  })
}

function summarizeMultilegStrategies(rows) {
  const groups = new Map()
  for (const row of rows) {
    const resolution = row.shadow_strategy_assignments?.multileg_resolution
    if (resolution?.dataStatus !== 'COMPLETE' || resolution?.publishEligibleEvidence !== true) continue
    for (const candidate of resolution.candidates || []) {
      const key = [candidate.strategyId, row.option_type, row.timeframe, resolution.version].join('|')
      if (!groups.has(key)) groups.set(key, { observations: [], cohorts: new Set(), strategyId: candidate.strategyId, direction: row.option_type, timeframe: row.timeframe, version: resolution.version })
      const group = groups.get(key)
      group.observations.push({
        returnOnRisk: Number(candidate.returnOnRisk),
        holdingMinutes: resolution.holdingMinutes,
        scannedAt: row.scanned_at,
        exitAt: resolution.exitAt,
        ticker: row.ticker,
      })
      if (row.experiment_cohort) group.cohorts.add(row.experiment_cohort)
    }
  }
  return [...groups.values()].map(group => {
    const outOfSample = summarizeReturns(group.observations)
    const validation = {
      partition: 'OUT_OF_SAMPLE',
      cohorts: group.cohorts.size,
      costModelApplied: true,
      sameSignalTiming: true,
      outOfSample,
    }
    return {
      strategyKey: [group.strategyId, group.direction, group.timeframe, group.version].join('|'),
      strategyId: group.strategyId,
      direction: group.direction,
      timeframe: group.timeframe,
      version: group.version,
      metrics: outOfSample,
      profitabilityGate: evaluateProfitabilityGate(validation),
    }
  }).sort((a, b) => b.metrics.sampleSize - a.metrics.sampleSize)
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
      multilegStrategies: summarizeMultilegStrategies(rows),
      shadowMeasurementCoverage: {
        spreadSettlements: rows.filter(row => row.shadow_spread_pnl_pct != null && Number.isFinite(Number(row.shadow_spread_pnl_pct))).length,
        shortenedHoldResults: rows.filter(row => row.shortened_hold_pnl_pct != null && Number.isFinite(Number(row.shortened_hold_pnl_pct))).length,
        fullGreeks: rows.filter(row => [row.theta, row.gamma, row.vega].every(value => value != null && Number.isFinite(Number(value)))).length,
        expectedMove: rows.filter(row => row.expected_move_pct != null && Number.isFinite(Number(row.expected_move_pct))).length,
        volatilityValue: rows.filter(row => row.breakeven_expected_move_ratio != null && Number.isFinite(Number(row.breakeven_expected_move_ratio))).length,
        liquidity: rows.filter(row => row.entry_spread_pct != null && Number.isFinite(Number(row.entry_spread_pct))).length,
        completeStrategyComparisons: rows.filter(row => row.shadow_strategy_assignments?.strategy_candidates?.coverage?.completeComparison === true).length,
        synchronizedMultilegResolutions: rows.filter(row => row.shadow_strategy_assignments?.multileg_resolution?.dataStatus === 'COMPLETE').length,
        unavailableMultilegResolutions: rows.filter(row => row.shadow_strategy_assignments?.multileg_resolution?.dataStatus === 'UNAVAILABLE').length,
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

module.exports._test = { summarizeShadowStrategies, summarizeMultilegStrategies }
