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
      return res.status(200).json({ cached: true, results: data || [] })
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
    return res.status(200).json({ cached: true, results: data })
  } catch (e) {
    console.error('[scan-cache] error:', e.message)
    return res.status(200).json({ cached: false, reason: e.message })
  }
}
