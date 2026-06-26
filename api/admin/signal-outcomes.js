// api/admin/signal-outcomes.js
//
// Admin-only, paginated/filtered read of signal_history's resolved (and
// unresolved) rows — backs the "Signal Outcomes" table in the Admin tab
// (Phase 3 of the signal success-rate tracking project; see Phase 0/1/2
// in conversation history and phase2-outcome-resolver-spec.md).
//
// Deliberately a separate endpoint from /api/admin/metrics rather than
// folded into its single aggregate payload — this table can grow to
// thousands of rows, so it needs real server-side filtering/pagination,
// not a client-side filter over an ever-growing unbounded fetch.

const { createClient } = require('@supabase/supabase-js');
const { getAuth, ADMIN_IDS } = require('../_lib/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_SORT_COLUMNS = new Set([
  'scanned_at', 'resolved_at', 'score', 'pnl_pct_at_expiry', 'ticker', 'timeframe',
]);
const ALLOWED_OUTCOMES = new Set([
  'WIN', 'LOSS', 'EXPIRED_PARTIAL', 'EXPIRED_FLAT', 'UNRESOLVED',
]);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { clerkId, isAdmin, error: authErr } = await getAuth(req);
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' });
  if (!isAdmin && !ADMIN_IDS.includes(clerkId)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    // ── Query params (all optional) ──────────────────────────────────────
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
    const sortBy   = ALLOWED_SORT_COLUMNS.has(req.query.sortBy) ? req.query.sortBy : 'scanned_at';
    const sortDir  = req.query.sortDir === 'asc' ? true : false; // default desc (newest first)

    const timeframe = req.query.timeframe || null;           // exact match against TF_CONFIG keys
    const ticker     = req.query.ticker ? req.query.ticker.toUpperCase() : null;
    const outcome     = req.query.outcome || null;             // 'WIN' | 'LOSS' | 'EXPIRED_PARTIAL' | 'EXPIRED_FLAT' | 'UNRESOLVED'

    if (outcome && !ALLOWED_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: `Invalid outcome filter. Allowed: ${[...ALLOWED_OUTCOMES].join(', ')}` });
    }

    let query = supabase.from('signal_history').select('*', { count: 'exact' });

    if (timeframe) query = query.eq('timeframe', timeframe);
    if (ticker)     query = query.eq('ticker', ticker);
    if (outcome === 'UNRESOLVED') {
      query = query.is('outcome', null);
    } else if (outcome) {
      query = query.eq('outcome', outcome);
    }

    query = query
      .order(sortBy, { ascending: sortDir })
      .range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // ── Summary stats for the CURRENT filter set (not just the current page) ──
    // A second lightweight query, same filters, just aggregated. Kept separate
    // from the paginated row fetch so the page-of-50 query stays fast and the
    // stats reflect "all rows matching this filter," not just what's visible.
    //
    // SCALING NOTE: unlike the row query above, this one is NOT paginated —
    // it pulls every matching row's `outcome` column to compute the
    // breakdown. Fine at today's volume (a few hundred rows), but if
    // signal_history grows into the tens of thousands, this should become a
    // single SQL aggregate (COUNT...GROUP BY outcome) via a Postgres
    // function/view instead of fetching all rows into Node to .filter() them.
    // Not done now because it adds a migration for a problem that doesn't
    // exist yet at current scale.
    let statsQuery = supabase.from('signal_history').select('outcome');
    if (timeframe) statsQuery = statsQuery.eq('timeframe', timeframe);
    if (ticker)     statsQuery = statsQuery.eq('ticker', ticker);
    // NOTE: outcome filter is intentionally NOT applied to the stats query —
    // we want the win/loss/expired breakdown across the whole filtered set
    // regardless of which outcome bucket the table itself is currently
    // showing, so switching the outcome filter doesn't also change the
    // baseline you're comparing against.
    const { data: statsRows, error: statsErr } = await statsQuery;
    if (statsErr) return res.status(500).json({ error: statsErr.message });

    const wins            = statsRows.filter(r => r.outcome === 'WIN').length;
    const losses          = statsRows.filter(r => r.outcome === 'LOSS').length;
    const expiredPartial  = statsRows.filter(r => r.outcome === 'EXPIRED_PARTIAL').length;
    const expiredFlat     = statsRows.filter(r => r.outcome === 'EXPIRED_FLAT').length;
    const unresolved      = statsRows.filter(r => r.outcome === null).length;
    // Phase 0 lock (explicit): EXPIRED_PARTIAL is excluded from the win-rate
    // NUMERATOR — it never counts as a WIN, full stop.
    // DENOMINATOR decision (made explicitly during Phase 3 build, since
    // Phase 0 didn't specify this): both EXPIRED_PARTIAL and EXPIRED_FLAT
    // count as LOSSES in the denominator — the strictest reading. A trade
    // that closed positive-but-below-target, or flat/negative at expiry
    // without ever cleanly hitting the stop, is treated as a non-win for
    // rate purposes, same as a verified stop-out. This makes the headline
    // win rate conservative by design: only a clean target-hit counts as a
    // win, everything else (loss, partial, flat) drags the rate down.
    const decided = wins + losses + expiredPartial + expiredFlat;
    const lossesForRate = losses + expiredPartial + expiredFlat;
    const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null;

    return res.status(200).json({
      rows: data,
      pagination: { page, pageSize, totalRows: count, totalPages: Math.ceil(count / pageSize) },
      stats: {
        wins, losses, expiredPartial, expiredFlat, unresolved,
        lossesForRate, // losses + expiredPartial + expiredFlat — matches the winRate denominator below; use this (not raw `losses`) when displaying a breakdown next to winRate
        winRate, // null if no decided trades yet — never render as 0%
        totalInFilter: statsRows.length,
      },
    });
  } catch (e) {
    console.error('[admin/signal-outcomes] unhandled error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
