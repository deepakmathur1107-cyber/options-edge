const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { compareHistoricalSignals } = require('../_lib/strategyBacktest')
const { summarizeReturns, evaluateProfitabilityGate } = require('../_lib/oeProfitability')

let _supabase = null
function sb() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  return _supabase
}

async function fetchRows(maxRows) {
  const rows = []
  const pageSize = 1000
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await sb().from('signal_history')
      .select('ticker,timeframe,option_type,primary_strike,underlying_price,underlying_price_at_resolution,iv,dte_at_signal,holding_minutes,scanned_at,resolved_at')
      .eq('is_lifecycle_primary', true)
      .not('outcome', 'is', null)
      .not('resolved_at', 'is', null)
      .not('underlying_price_at_resolution', 'is', null)
      .not('iv', 'is', null)
      .order('scanned_at', { ascending: true })
      .range(from, Math.min(maxRows, from + pageSize) - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return rows
}

function report(signals) {
  const comparisons = compareHistoricalSignals(signals)
  return comparisons.map(comparison => {
    const split = Math.floor(comparison.observations.length * 0.7)
    const inSampleRows = comparison.observations.slice(0, split)
    const outOfSampleRows = comparison.observations.slice(split)
    const cohorts = new Set(outOfSampleRows.map(row => String(row.scannedAt || '').slice(0, 7)).filter(Boolean))
    const validation = {
      // Modeled historical evidence is useful for comparison, but deliberately
      // cannot satisfy the forward publication gate.
      partition: 'MODELED_OUT_OF_SAMPLE',
      cohorts: cohorts.size,
      costModelApplied: true,
      sameSignalTiming: true,
      outOfSample: summarizeReturns(outOfSampleRows),
    }
    return {
      strategy: comparison.strategy,
      evidenceType: 'MODELED_CONSTANT_IV',
      publishEligibleEvidence: false,
      fullSample: comparison.metrics,
      inSample: summarizeReturns(inSampleRows),
      outOfSample: validation.outOfSample,
      cohortCount: cohorts.size,
      profitabilityGate: evaluateProfitabilityGate(validation),
    }
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const { clerkId, isAdmin, error } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: error || 'Unauthorized' })
  if (!isAdmin && !ADMIN_IDS.includes(clerkId)) return res.status(403).json({ error: 'Admin access required' })

  try {
    const maxRows = Math.min(25_000, Math.max(100, Number(req.query.limit) || 10_000))
    const rows = await fetchRows(maxRows)
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      evidenceType: 'MODELED_CONSTANT_IV',
      sameSignalTiming: true,
      costModelApplied: true,
      publishEligibleEvidence: false,
      eligibleSignals: rows.length,
      splitMethod: 'CHRONOLOGICAL_70_30',
      strategies: report(rows),
      limitation: 'Historical constant-IV modeling is research evidence only. Promotion requires actual synchronized forward leg marks.',
    })
  } catch (backtestError) {
    console.error('[admin/strategy-backtest] failed:', backtestError.message)
    return res.status(500).json({ error: 'Failed to build strategy backtest' })
  }
}

module.exports._test = { report }
