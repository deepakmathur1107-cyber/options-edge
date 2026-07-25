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
  // AUDIT FIX (2026-07-25, Finding 3): AMBIGUOUS and DATA_UNAVAILABLE are
  // NOT the same concept as UNRESOLVED and need their own filters. Before
  // this fix, UNRESOLVED (outcome IS NULL) silently included terminal
  // data_unavailable rows too (33 confirmed live) — those are DONE, just
  // without a WIN/LOSS outcome, not still pending.
  'AMBIGUOUS', 'DATA_UNAVAILABLE',
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
    const outcome     = req.query.outcome || null;             // 'WIN' | 'LOSS' | 'EXPIRED_PARTIAL' | 'EXPIRED_FLAT' | 'UNRESOLVED' | 'AMBIGUOUS' | 'DATA_UNAVAILABLE'

    if (outcome && !ALLOWED_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: `Invalid outcome filter. Allowed: ${[...ALLOWED_OUTCOMES].join(', ')}` });
    }

    let query = supabase.from('signal_history').select('*', { count: 'exact' });

    // Default to primary-only, matching the summary stats below — otherwise
    // a single real trade re-scanned 30x in a day shows as 30 separate rows
    // all carrying the same propagated outcome, reading as 30 wins/losses
    // instead of one. Pass ?includeRescans=true to see every scan-tick row
    // for a specific lifecycle (the original QA use case — checking score
    // drift across a day) — intentionally opt-in, not the default view.
    const includeRescans = req.query.includeRescans === 'true';
    if (!includeRescans) query = query.eq('is_lifecycle_primary', true);

    if (timeframe) query = query.eq('timeframe', timeframe);
    if (ticker)     query = query.eq('ticker', ticker);
    // AUDIT FIX (2026-07-25, Finding 3): UNRESOLVED now also requires
    // resolved_at IS NULL — a terminal data_unavailable row has outcome
    // NULL but IS resolved (resolved_at set), and was wrongly showing up
    // as "unresolved" before this fix. DATA_UNAVAILABLE and AMBIGUOUS are
    // now their own distinct filters, matching the audit's recommended
    // definitions exactly.
    if (outcome === 'UNRESOLVED') {
      query = query.is('outcome', null).is('resolved_at', null);
    } else if (outcome === 'DATA_UNAVAILABLE') {
      query = query.is('outcome', null).not('resolved_at', 'is', null).eq('resolution_method', 'data_unavailable');
    } else if (outcome) {
      // Covers AMBIGUOUS too — it's a real value stored in the outcome
      // column (outcome = 'AMBIGUOUS'), so the plain equality path already
      // handles it correctly once it's in ALLOWED_OUTCOMES.
      query = query.eq('outcome', outcome);
    }

    query = query
      .order(sortBy, { ascending: sortDir })
      .range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // ── Summary stats for the CURRENT filter set (not just the current page) ──
    // Previously this fetched every matching row's `outcome` column into Node
    // and .filter()'d it client-side -- the comment above used to say "fine
    // at today's volume (a few hundred rows)," but signal_history has since
    // grown to 17,000+ rows, well past Supabase/PostgREST's default 1000-row
    // cap on unbounded selects. That meant statsRows silently truncated at
    // 1000 whenever a filter (or no filter at all) matched more than that --
    // wins/losses/winRate/totalInFilter were all quietly wrong, with no
    // error or indication anything was capped. Confirmed live: "Total in
    // filter: 1000" showing under "All timeframes / All outcomes" with no
    // filter applied, against a table holding 17,240+ rows.
    //
    // Fixed by using count-only queries (head:true) per outcome bucket --
    // these return just a row count from Postgres without transferring any
    // row data, so there's no 1000-row transfer limit to hit and no need to
    // pull rows into Node just to .filter() them.
    // AUDIT FIX (2026-07-25, Finding 3): countFor took a bare outcome
    // string OR null (meaning "unresolved"), and null only ever checked
    // outcome IS NULL — silently including terminal data_unavailable rows.
    // Now takes an explicit category name so each of the four non-decided
    // states (UNRESOLVED / DATA_UNAVAILABLE / AMBIGUOUS / a real outcome
    // value) gets its own correct filter, matching the audit's definitions:
    //   UNRESOLVED:       outcome IS NULL AND resolved_at IS NULL
    //   DATA_UNAVAILABLE: outcome IS NULL AND resolved_at IS NOT NULL AND resolution_method = 'data_unavailable'
    //   AMBIGUOUS / WIN / LOSS / etc: outcome = <value> (AMBIGUOUS is a
    //     real stored outcome value, not a null-outcome state)
    const countFor = async (category) => {
      let q = supabase.from('signal_history').select('*', { count: 'exact', head: true }).eq('is_lifecycle_primary', true);
      if (timeframe) q = q.eq('timeframe', timeframe);
      if (ticker)     q = q.eq('ticker', ticker);
      if (category === 'UNRESOLVED') {
        q = q.is('outcome', null).is('resolved_at', null);
      } else if (category === 'DATA_UNAVAILABLE') {
        q = q.is('outcome', null).not('resolved_at', 'is', null).eq('resolution_method', 'data_unavailable');
      } else {
        q = q.eq('outcome', category);
      }
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    };

    let wins, losses, expiredPartial, expiredFlat, unresolved, dataUnavailable, ambiguous, totalInFilter;
    try {
      const [w, l, ep, ef, u, du, amb, total] = await Promise.all([
        countFor('WIN'), countFor('LOSS'), countFor('EXPIRED_PARTIAL'),
        countFor('EXPIRED_FLAT'), countFor('UNRESOLVED'), countFor('DATA_UNAVAILABLE'),
        countFor('AMBIGUOUS'),
        (async () => {
          let q = supabase.from('signal_history').select('*', { count: 'exact', head: true }).eq('is_lifecycle_primary', true);
          if (timeframe) q = q.eq('timeframe', timeframe);
          if (ticker)     q = q.eq('ticker', ticker);
          const { count, error } = await q;
          if (error) throw error;
          return count || 0;
        })(),
      ]);
      wins = w; losses = l; expiredPartial = ep; expiredFlat = ef; unresolved = u;
      dataUnavailable = du; ambiguous = amb; totalInFilter = total;
    } catch (statsErr) {
      return res.status(500).json({ error: statsErr.message });
    }
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
        wins, losses, expiredPartial, expiredFlat, unresolved, dataUnavailable, ambiguous,
        lossesForRate, // losses + expiredPartial + expiredFlat — matches the winRate denominator below; use this (not raw `losses`) when displaying a breakdown next to winRate
        winRate, // null if no decided trades yet — never render as 0%
        totalInFilter,
      },
    });
  } catch (e) {
    console.error('[admin/signal-outcomes] unhandled error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
