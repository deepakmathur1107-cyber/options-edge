// api/track-record.js
// GET /api/track-record?tf=Swing (21–45 DTE)   (tf optional — omit for pooled)
//
// SCAFFOLD — item 1, not yet wired to any frontend. Built ahead of having
// real resolved data (signal_history has 0 resolved outcomes as of this
// writing) so the query/response SHAPE is decided and reviewable now,
// without anyone needing to invent numbers to test against.
//
// Decisions already made (session history) and encoded here:
// - Show RAW COUNTS, not a percentage, until n is large enough that a
//   percentage isn't false precision (e.g. "3 of 5 hit target" rather than
//   "60%"). MIN_N_FOR_PERCENT is the threshold; tune once real data exists
//   and you can see what a noisy small-n percentage actually looks like.
// - Pooled-vs-per-timeframe was explicitly left undecided pending real data
//   shape (session note: "decide later once we see the data shape"). This
//   endpoint supports BOTH via the optional ?tf= param — the decision can
//   be made in the FRONTEND consumer, not forced here.
// - Zero-resolved state returns a specific, honest "still accumulating"
//   shape — never a fabricated percentage, never hidden as a generic error.

const MIN_N_FOR_PERCENT = 10   // PLACEHOLDER — not yet validated against
                                // real data distribution. Revisit once
                                // signal_history actually has resolved rows
                                // to look at.

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[track-record] supabase init failed:', e.message) }
  }
  return _sb
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
      .select('outcome')
      .eq('is_lifecycle_primary', true)
      .not('outcome', 'is', null)
      // AMBIGUOUS = daily-bar fallback where a single daily bar crossed BOTH
      // target and stop (unknown intraday order). Deliberately excluded from
      // the win-rate denominator: it's a resolved-but-undeterminable outcome,
      // and counting it (as neither a win) would silently deflate the rate.
      // Without this, .not('outcome','is',null) would sweep it in as
      // "resolved" — the exact filter-consistency trap this codebase has hit
      // before. Keep this exclusion wherever a win-rate denominator is built.
      .neq('outcome', 'AMBIGUOUS')
    if (tf) query = query.eq('timeframe', tf)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    const rows = data || []
    const n = rows.length

    // Strictest win-rate definition per session decision: only WIN counts
    // as a win. EXPIRED_PARTIAL and EXPIRED_FLAT both count as losses,
    // same as LOSS itself — confirmed in SignalOutcomesTable.jsx's existing
    // admin-only logic; this endpoint mirrors that same definition rather
    // than introducing a second one.
    const wins = rows.filter(r => r.outcome === 'WIN').length
    const losses = n - wins

    if (n === 0) {
      return res.status(200).json({
        status: 'accumulating',
        timeframe: tf,
        n: 0,
        message: 'Still accumulating data — check back soon.',
      })
    }

    const showPercent = n >= MIN_N_FOR_PERCENT
    return res.status(200).json({
      status: showPercent ? 'ready' : 'low_sample',
      timeframe: tf,
      n, wins, losses,
      winRatePct: showPercent ? Math.round((wins / n) * 1000) / 10 : null,
      // low_sample responses deliberately omit winRatePct (null, not a
      // computed-but-unstable number) — the FRONTEND should render n/wins
      // as raw counts in this state, per the "3 of 5" decision above, not
      // attempt to format a percentage from a small n.
    })
  } catch (e) {
    console.error('[track-record] error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
