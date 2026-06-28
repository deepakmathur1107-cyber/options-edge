// api/admin/trade-outcomes.js
//
// Admin-only, paginated/filtered read of trade_outcomes joined with the
// originating trades row — backs the "Trade Outcomes" table, sibling to
// the existing "Signal Outcomes" table in the same admin section.
//
// Deliberately mirrors api/admin/signal-outcomes.js's contract closely
// (same param names, same pagination shape, same win-rate convention) so
// the frontend component can reuse nearly identical logic — these are two
// views onto the same KIND of question (resolved-outcome win rate), just
// over two different source tables (signal_history vs. trade_outcomes/
// trades), and keeping their contracts parallel makes both easier to
// reason about together, not because the underlying tables are the same.

const { createClient } = require('@supabase/supabase-js');
const { getAuth, ADMIN_IDS } = require('../_lib/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_SORT_COLUMNS = new Set([
  'resolved_at', 'pnl_pct_at_expiry', 'ticker',
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
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
    // sortBy/sortDir apply to the JOINED result in JS (see below) for
    // 'ticker' (lives on trades, not trade_outcomes) — Supabase's
    // .order() can't sort by a column on the embedded/joined table in a
    // single query the way this needs, so ticker-sort is handled as a
    // post-fetch JS sort on the current page only. resolved_at/
    // pnl_pct_at_expiry sort natively via trade_outcomes' own .order().
    const sortBy   = ALLOWED_SORT_COLUMNS.has(req.query.sortBy) ? req.query.sortBy : 'resolved_at';
    const sortDir  = req.query.sortDir === 'asc' ? true : false;

    const ticker  = req.query.ticker ? req.query.ticker.toUpperCase() : null;
    const outcome = req.query.outcome || null;

    if (outcome && !ALLOWED_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: `Invalid outcome filter. Allowed: ${[...ALLOWED_OUTCOMES].join(', ')}` });
    }

    // trade_outcomes only has trade_id + resolution columns — ticker/
    // option_type/strike/expiration/entry_price live on trades. Embedded
    // select pulls both in one query; trades!inner ensures a trade_outcomes
    // row with a deleted/missing trade (shouldn't happen given the FK's
    // ON DELETE CASCADE, but defensive) doesn't silently show as a blank row.
    let query = supabase
      .from('trade_outcomes')
      .select('*, trades!inner(ticker, option_type, strike, expiration, entry_price, target_price, stop_price, conviction, timeframe, created_at)', { count: 'exact' });

    if (outcome === 'UNRESOLVED') {
      query = query.is('outcome', null);
    } else if (outcome) {
      query = query.eq('outcome', outcome);
    }
    if (ticker) query = query.eq('trades.ticker', ticker);

    if (sortBy === 'ticker') {
      // Can't sort by an embedded column server-side here -- order by
      // resolved_at as a stable base (real column on trade_outcomes itself;
      // FIXED here after a live error caught a wrong assumption that
      // trade_outcomes had a created_at column -- it doesn't, only
      // resolved_at/hit_target_at/hit_stop_at), then re-sort the returned
      // page by ticker in JS below. This means ticker-sort is only stable
      // WITHIN a page, not globally across pages -- an accepted limitation
      // (same scale assumption as signal-outcomes.js's stats query: fine
      // at today's volume, would need a proper view/function if
      // trade_outcomes ever grows large enough for this to matter).
      query = query.order('resolved_at', { ascending: false });
    } else {
      query = query.order(sortBy, { ascending: sortDir });
    }
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    let rows = data || [];
    if (sortBy === 'ticker') {
      rows = [...rows].sort((a, b) => {
        const cmp = (a.trades?.ticker || '').localeCompare(b.trades?.ticker || '');
        return sortDir ? cmp : -cmp;
      });
    }

    // Stats query — same shape/reasoning as signal-outcomes.js: a second,
    // unpaginated query over the CURRENT filter (minus the outcome filter
    // itself, so switching outcome filters doesn't change the baseline).
    let statsQuery = supabase.from('trade_outcomes').select('outcome, resolution_method, trades!inner(ticker)');
    if (ticker) statsQuery = statsQuery.eq('trades.ticker', ticker);
    const { data: statsRows, error: statsErr } = await statsQuery;
    if (statsErr) return res.status(500).json({ error: statsErr.message });

    const wins           = statsRows.filter(r => r.outcome === 'WIN').length;
    const losses         = statsRows.filter(r => r.outcome === 'LOSS').length;
    const expiredPartial = statsRows.filter(r => r.outcome === 'EXPIRED_PARTIAL').length;
    const expiredFlat    = statsRows.filter(r => r.outcome === 'EXPIRED_FLAT').length;
    // unresolved used to mean "outcome IS NULL," which only ever covered
    // _noUsableData retry rows in practice (still-open trades never wrote
    // a row at all, before resolve-trade-outcomes.js's still-open upsert
    // fix). Now that still-open trades DO write a row, outcome IS NULL
    // covers two genuinely different states distinguished only by
    // resolution_method -- split here so the panel doesn't conflate
    // "healthy, just hasn't hit target/stop yet" with "stuck retrying,
    // can't get a price quote." stillOpen keeps the same field name the
    // frontend already reads (stats.unresolved) for backward compat, but
    // now means specifically "open," with dataUnavailable broken out
    // separately.
    const stillOpenRows  = statsRows.filter(r => r.outcome === null && r.resolution_method === 'still_open').length;
    const dataUnavailable = statsRows.filter(r => r.outcome === null && r.resolution_method !== 'still_open').length;
    const unresolved     = stillOpenRows + dataUnavailable;
    // Same strict win-rate convention as signal-outcomes.js, applied here
    // for consistency between the two tables — NOT re-derived independently,
    // intentionally kept identical: only a clean WIN counts toward the
    // numerator; LOSS + EXPIRED_PARTIAL + EXPIRED_FLAT all count as
    // non-wins in the denominator.
    const decided = wins + losses + expiredPartial + expiredFlat;
    const lossesForRate = losses + expiredPartial + expiredFlat;
    const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null;

    return res.status(200).json({
      rows,
      pagination: { page, pageSize, totalRows: count, totalPages: Math.ceil((count || 0) / pageSize) },
      stats: {
        wins, losses, expiredPartial, expiredFlat, unresolved,
        stillOpen: stillOpenRows, dataUnavailable,
        lossesForRate, winRate,
        totalInFilter: statsRows.length,
      },
    });
  } catch (e) {
    console.error('[admin/trade-outcomes] unhandled error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
