// api/scan-cache.js
// GET /api/scan-cache?ticker=NVDA&tf=Swing (21–45 DTE)
//   → cached row if fresh (expires_at > now), else { cached: false }
// GET /api/scan-cache?tf=Swing (21–45 DTE)&minScore=80
//   → all fresh rows above threshold for that timeframe, score desc
//     (used by the SCAN tab's "view today's alerts" list, fed by the cron
//     instead of requiring a live in-browser auto-scan)
//
// FIX: this endpoint previously had zero authentication and CORS open to '*',
// meaning anyone — no account, no subscription — could read the scored scan
// results that are the actual paid product. Now requires a verified Clerk
// session with an active/trialing subscription (or admin).

const { getAuth, ADMIN_IDS } = require('./_lib/auth')
const { attachLifecycleSummaries } = require('./_lib/lifecycleSummary')
const { buildSizingForScanRow } = require('./_lib/userPositionSizing')
const { attachQualityShortlist } = require('./_lib/qualityShortlist')
const { CLUSTER_MIN_COUNT } = require('./_lib/clusterConfig')

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[scan-cache] supabase init failed:', e.message) }
  }
  return _sb
}

async function hasActiveSub(clerkId, supabase) {
  if (ADMIN_IDS.includes(clerkId)) return true
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('clerk_id', clerkId)
      .maybeSingle()
    const s = data?.status || 'inactive'
    return s === 'active' || s === 'trialing'
  } catch { return false }
}

async function getSizingPrefs(client, clerkId) {
  const { data, error } = await client
    .from('alert_prefs')
    .select('account_equity,planned_account_risk_pct,max_premium_outlay_pct,max_position_contracts')
    .eq('clerk_user_id', clerkId)
    .maybeSingle()
  // Safe during a rolling deploy if API code arrives before the migration.
  if (error) return {}
  return data || {}
}

function attachPositionSizing(rows, prefs) {
  for (const row of rows || []) row.position_sizing = buildSizingForScanRow(row, prefs)
}

// CLUSTER_MIN_COUNT: minimum same-sector + same-direction signals in a single
// batch before it's surfaced to the user as a concentration flag. Tunable —
// not yet validated against more than one day's real data. See session notes
// June 25, 2026: today's batch showed sector+direction groups as large as 18
// (Financials/call) and 13 (Information Technology/put), confirmed NOT pure
// independent-stock agreement — chg_pct within the Financials/call cluster
// ranged from -1.11% to +6.68%, including several names red on the day. The
// shared driver is the market-regime term in convictionScore.cjs
// (spxChgToday/ndxChgToday -> marketRising/marketFalling -> flat +/-6/+/-12
// per optType, applied identically to every ticker in the batch) plus genuine
// sector co-movement on top of it. This banner doesn't try to separate the
// two -- it just tells the user the structural fact (count, sector,
// direction) so they don't mistake batch breadth for independent
// diversification.
// computeClusters: groups by (sector, direction) and returns only groups at
// or above CLUSTER_MIN_COUNT. Deliberately takes a separate, UNCAPPED query
// result -- never the same rows already truncated by PER_TF_LIMIT/.limit(50)
// below. A cluster of 18 could easily have only a handful of its members
// survive the score-desc + per-tf cap, so counting on the capped list would
// silently undercount or misrepresent the true cluster size that produced
// it. Banner and list must agree with the underlying data even when they
// don't agree with each other in row count -- the banner describes the
// batch, not the rendered page.
//
// Direction source CONFIRMED against live scan_results (June 25, 2026):
// direction_decision is { gap, isClose, otherSideScore } -- it does NOT
// carry a 'side' field, despite that being pickBetterSide's return shape in
// convictionScore.cjs. side/winner/loser apparently aren't persisted to this
// column. trade_type is the real, populated direction field, as a display
// string like "Long Put" / "Long Call" -- not the raw 'put'/'call' used
// elsewhere (e.g. signal_history.option_type). Parsed accordingly below.
function computeClusters(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (!row.sector || !row.trade_type) continue
    const direction = /put/i.test(row.trade_type) ? 'put'
                     : /call/i.test(row.trade_type) ? 'call'
                     : null
    if (!direction) continue
    const key = `${row.sector}|${direction}`
    if (!groups.has(key)) groups.set(key, { sector: row.sector, direction, tickers: [] })
    groups.get(key).tickers.push(row.ticker)
  }
  return [...groups.values()]
    .filter(g => g.tickers.length >= CLUSTER_MIN_COUNT)
    .sort((a, b) => b.tickers.length - a.tickers.length)
}

module.exports = async function handler(req, res) {
  // FIX: was '*' — this endpoint serves paid-tier data and must not be
  // readable from arbitrary origins.
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // FIX: was fully unauthenticated. Require a verified session + active plan.
  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })

  const client = sb()
  if (!client) return res.status(200).json({ cached: false, reason: 'cache_unavailable' })

  if (!ADMIN_IDS.includes(clerkId)) {
    const active = await hasActiveSub(clerkId, client)
    if (!active) {
      return res.status(402).json({
        error: 'An active subscription is required to view scan results.',
        code: 'SUBSCRIPTION_EXPIRED',
      })
    }
  }

  const { ticker, tf, minScore } = req.query
  const sizingPrefs = await getSizingPrefs(client, clerkId)
  // tf is required for single-ticker lookups (an exact cache check before a
  // manual scan needs one specific timeframe), but optional in list mode —
  // the Auto-scanner now shows all timeframes mixed together by default,
  // with the timeframe shown per-row instead of pre-filtering server-side.
  if (!tf && ticker) return res.status(400).json({ error: 'tf required for single-ticker lookup' })

  try {
    if (ticker) {
      // Single-ticker lookup — used right before a manual scan kicks off.
      const { data, error } = await client
        .from('scan_results')
        .select('*')
        .eq('ticker', ticker.toUpperCase())
        .eq('timeframe', tf)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()

      if (error) return res.status(200).json({ cached: false, reason: error.message })
      if (!data)  return res.status(200).json({ cached: false })
      await attachLifecycleSummaries(client, [data])
      attachPositionSizing([data], sizingPrefs)
      attachQualityShortlist([data])
      return res.status(200).json({ cached: true, result: data })
    }

    // List mode — all fresh rows above threshold, freshest/highest first.
    // Single indexed query, no live scanning — the cron already refreshes
    // this table every 15-60 min on its own schedule, so this is always
    // at most one cycle stale and responds in well under a second.
    const threshold = parseInt(minScore || '60', 10)
    if (tf) {
      const { data, error } = await client
        .from('scan_results')
        .select('*')
        .eq('timeframe', tf)
        .gte('score', threshold)
        .gt('expires_at', new Date().toISOString())
        .order('score', { ascending: false })
        .limit(50)
      if (error) return res.status(200).json({ cached: false, reason: error.message, results: [] })

      // Clustering: separate, uncapped query against the SAME filter
      // conditions (timeframe/threshold/freshness) as above, but selecting
      // only the columns needed to group -- this must never reuse the
      // .limit(50) result above, since a real cluster larger than 50 (or
      // just outside the top-50-by-score window) would be silently
      // undercounted if computed from the already-truncated list.
      const { data: allFresh, error: clusterErr } = await client
        .from('scan_results')
        .select('ticker, sector, trade_type')
        .eq('timeframe', tf)
        .gte('score', threshold)
        .gt('expires_at', new Date().toISOString())
      const clusters = clusterErr ? [] : computeClusters(allFresh || [])

      await attachLifecycleSummaries(client, data || [])
      attachPositionSizing(data || [], sizingPrefs)
      attachQualityShortlist(data || [])
      return res.status(200).json({ cached: true, results: data || [], clusters })
    }
    // No tf filter — mixing all 4 timeframes. A flat ORDER BY score LIMIT 50
    // would be dominated by whichever timeframe happens to have the most
    // qualifying candidates (e.g. Swing routinely has 10x LEAP's count),
    // silently burying the others again even though nothing's pre-filtered
    // anymore. Cap each timeframe's contribution instead so the mix actually
    // reflects all 4, not just whichever is most populous today.
    const PER_TF_LIMIT = 15
    const timeframes = ['Quick (5–14 DTE)', 'Swing (21–45 DTE)', 'LEAP (90–180 DTE)', 'Deep LEAP (180–365 DTE)']
    const perTfResults = await Promise.all(timeframes.map(async (tfKey) => {
      const { data, error } = await client
        .from('scan_results')
        .select('*')
        .eq('timeframe', tfKey)
        .gte('score', threshold)
        .gt('expires_at', new Date().toISOString())
        .order('score', { ascending: false })
        .limit(PER_TF_LIMIT)
      if (error) { console.error(`[scan-cache] mixed-tf query failed for ${tfKey}:`, error.message); return [] }
      return data || []
    }))
    const data = perTfResults.flat().sort((a, b) => b.score - a.score)

    // Clustering computed PER TIMEFRAME, not pooled across all four — a
    // cluster within Quick (5-14 DTE) and a same-sector/direction cluster
    // within Deep LEAP (180-365 DTE) are not the same concentrated bet; they
    // reflect different horizons/reasoning even if they happen to share a
    // sector and direction today. Each uses its own uncapped query, same
    // reasoning as the single-tf path above.
    const clustersByTf = {}
    await Promise.all(timeframes.map(async (tfKey) => {
      const { data: allFresh, error } = await client
        .from('scan_results')
        .select('ticker, sector, trade_type')
        .eq('timeframe', tfKey)
        .gte('score', threshold)
        .gt('expires_at', new Date().toISOString())
      clustersByTf[tfKey] = error ? [] : computeClusters(allFresh || [])
    }))

    await attachLifecycleSummaries(client, data)
    attachPositionSizing(data, sizingPrefs)
    attachQualityShortlist(data)
    return res.status(200).json({ cached: true, results: data, clustersByTf })
  } catch (e) {
    console.error('[scan-cache] error:', e.message)
    return res.status(200).json({ cached: false, reason: e.message })
  }
}
