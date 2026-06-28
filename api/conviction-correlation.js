// api/conviction-correlation.js
// GET /api/conviction-correlation?tf=Swing (21–45 DTE)   (tf optional — omit for pooled)
//
// Item: conviction-score-to-outcome correlation. Same honest-empty-state
// philosophy and same signal_history source as track-record.js — this
// endpoint answers a different question though: not "what's our overall
// win rate" but "does a higher conviction score actually predict a better
// outcome." Built same session as track-record.js was validated against
// real data (2026-06-28), reusing every pattern that already proved out:
// CORS locked to production origin, public/no-auth (aggregate, non-personal
// data, same reasoning as track-record.js), raw counts below MIN_N_FOR_PERCENT
// rather than a misleadingly precise small-n percentage.
//
// Bucket thresholds (50-69 / 70-84 / 85+) are NOT arbitrary round numbers —
// confirmed against signal_history's real score distribution (min 50, max 95,
// avg 73 as of this writing; sub-50 scores apparently never reach this table,
// presumably filtered upstream by scanLogic's hard-block checks) and matched
// to the conviction tiers TradeLog.jsx's backtest view already uses
// (convOf(t)>=90 / >=70 / below — see hi90/hi70/lo70 in that file) so this
// endpoint's tiers mean the same thing a user may already recognize from the
// Trade Log's own backtest breakdown, not a third, different definition.

const MIN_N_FOR_PERCENT = 10

const BUCKETS = [
  { id: 'high',     label: '85+',    min: 85,  max: 999 },
  { id: 'good',      label: '70-84', min: 70,  max: 84  },
  { id: 'moderate',  label: '50-69', min: 50,  max: 69  },
]

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[conviction-correlation] supabase init failed:', e.message) }
  }
  return _sb
}

// Same strictest win-rate definition track-record.js uses: only WIN counts
// as a win. EXPIRED_PARTIAL and EXPIRED_FLAT both count as losses, same as
// LOSS itself — one definition across every aggregate stat in this app,
// not a second one invented here.
function bucketStats(rows) {
  const n = rows.length
  const wins = rows.filter(r => r.outcome === 'WIN').length
  const losses = n - wins
  const showPercent = n >= MIN_N_FOR_PERCENT
  return {
    n, wins, losses,
    winRatePct: showPercent ? Math.round((wins / n) * 1000) / 10 : null,
    status: n === 0 ? 'accumulating' : (showPercent ? 'ready' : 'low_sample'),
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  const tf = req.query.tf || null

  try {
    let query = client
      .from('signal_history')
      .select('outcome, score')
      .not('outcome', 'is', null)
      .not('score', 'is', null)
    if (tf) query = query.eq('timeframe', tf)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    const rows = data || []
    const totalN = rows.length

    if (totalN === 0) {
      return res.status(200).json({
        status: 'accumulating',
        timeframe: tf,
        totalN: 0,
        buckets: [],
        message: 'Still accumulating data — check back soon.',
      })
    }

    const buckets = BUCKETS.map(b => {
      const bucketRows = rows.filter(r => r.score >= b.min && r.score <= b.max)
      return { id: b.id, label: b.label, ...bucketStats(bucketRows) }
    })

    return res.status(200).json({
      status: 'ready',
      timeframe: tf,
      totalN,
      buckets,
    })
  } catch (e) {
    console.error('[conviction-correlation] error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
