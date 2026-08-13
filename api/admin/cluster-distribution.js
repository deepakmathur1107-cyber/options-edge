const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { CLUSTER_MIN_COUNT } = require('../_lib/clusterConfig')
const { buildClusterDistribution } = require('../_lib/clusterDistribution')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const PAGE_SIZE = 1000
const MAX_ROWS = 50000

async function fetchHistory(since) {
  const rows = []
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('signal_history')
      .select('scanned_at, timeframe, sector, option_type, ticker')
      .gte('scanned_at', since)
      .not('sector', 'is', null)
      .order('scanned_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Cache-Control', 'private, no-store, max-age=0')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { clerkId, isAdmin, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })
  if (!isAdmin && !ADMIN_IDS.includes(clerkId)) return res.status(403).json({ error: 'Admin access required' })

  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14))
    const minSize = Math.max(1, parseInt(req.query.minSize, 10) || Math.max(1, CLUSTER_MIN_COUNT - 1))
    const sinceDate = new Date()
    sinceDate.setDate(sinceDate.getDate() - days)
    const { rows, truncated } = await fetchHistory(sinceDate.toISOString())
    const { clusters, runCount } = buildClusterDistribution(rows, minSize)
    const distinctDays = new Set(rows.map(row => row.scanned_at.slice(0, 10)))

    return res.status(200).json({
      requestedDays: days,
      windowStart: sinceDate.toISOString(),
      generatedAt: new Date().toISOString(),
      distinctDaysFound: distinctDays.size,
      lessHistoryThanRequested: distinctDays.size < days,
      minSize,
      liveClusterMinCount: CLUSTER_MIN_COUNT,
      clusterRunMethod: 'timeframe_and_7_minute_gap',
      runsAnalyzed: runCount,
      rowsAnalyzed: rows.length,
      truncated,
      clusters,
    })
  } catch (error) {
    console.error('[admin/cluster-distribution] error:', error.message)
    return res.status(500).json({ error: 'Failed to load cluster distribution' })
  }
}
