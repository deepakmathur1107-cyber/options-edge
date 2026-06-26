// api/data-freshness.js
// GET /api/data-freshness?signalId=<signal_history.id>
//
// SCAFFOLD — item 3. Backend health (the chg_pct/iv staleness guards
// themselves) was confirmed working over a week ago and re-confirmed
// tonight (12,348 signals in the last 24h, 0 zero-chg_pct, 1/12348 bad_iv
// — same healthy proportions as the original check). What's NOT yet
// decided is whether/how to surface this to a USER per-signal, on a
// specific conviction score, as a confidence indicator.
//
// This endpoint answers a narrower, decided question first: "was THIS
// specific signal computed during a window where staleness is a known
// risk (pre-market) or with any flagged data-quality issue" — a yes/no +
// reason, not a continuous "freshness score." Whether the frontend shows
// this as a badge on the conviction score, a separate line, a tooltip, or
// nothing at all is the still-open product decision (see file-bottom note).

const PRE_MARKET_END_ET_HOUR = 9.5   // 9:30 AM ET — matches isOpeningWindow's
                                       // own boundary in scanLogic.js; reuse
                                       // that exact constant if this is ever
                                       // wired for real, rather than letting
                                       // two copies of "market open time"
                                       // drift apart.

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[data-freshness] supabase init failed:', e.message) }
  }
  return _sb
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const signalId = req.query.signalId
  if (!signalId) return res.status(400).json({ error: 'Missing ?signalId=' })

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  try {
    const { data: signal, error } = await client
      .from('signal_history')
      .select('chg_pct, iv, scanned_at')
      .eq('id', signalId)
      .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })

    const flags = []
    if (signal.chg_pct === 0) flags.push('zero_chg_pct')
    // Same '0 or null' check used throughout tonight's session queries —
    // matches safeIV's own fallback value (scanLogic.js / convictionScore.cjs)
    if (signal.iv === 0 || signal.iv == null) flags.push('iv_unavailable')

    return res.status(200).json({
      signalId,
      scannedAt: signal.scanned_at,
      flags,
      // NOT a "freshness score" by design — see header comment. Just the
      // raw flags; any scoring/badging is a frontend decision not yet made.
    })
  } catch (e) {
    console.error('[data-freshness] error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// STILL OPEN (product decision needed before any frontend work starts):
// ─────────────────────────────────────────────────────────────────────────
// - Where does this show? Options discussed but not decided: a small badge
//   next to the conviction score on Scan results; a tooltip on hover; a
//   separate "data quality" line; or nothing user-facing at all (keep this
//   as an internal/admin health check only, the way it's been treated so
//   far).
// - Is "flags: []" (clean) worth a positive indicator, or does absence of
//   a flag simply mean no badge shows at all? (Same "silence = honest
//   default" pattern chosen for item 5's verdict badge — worth reusing
//   that same UX principle here for consistency, but not yet confirmed.)
