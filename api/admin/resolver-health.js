// api/admin/resolver-health.js
// Added 2026-07-25. Phase 2 of the Options Edge Audit Report — resolver
// health monitoring. Read-only, admin-only, same auth pattern as
// shadow-data.js and metrics.js (real Clerk JWKS verification). Changes
// nothing about the resolver or scoring; purely observational.
//
// Built now (not deferred like the forward-validation dashboard) because
// it doesn't depend on live LIVE_AT_SIGNAL data existing yet — it reports
// on resolver mechanics (backlog, retry distribution, cursor health,
// dead-letter rate), which are meaningful today regardless of whether any
// forward cohort data has accumulated.

const { createClient } = require('@supabase/supabase-js');
const { getAuth, ADMIN_IDS } = require('../_lib/auth');
const { deriveResolverRunHealth } = require('../_lib/resolverHealth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const countQuery = (build) => build(
      supabase.from('signal_history').select('*', { count: 'exact', head: true }).eq('is_lifecycle_primary', true)
    ).then(({ count, error }) => { if (error) throw error; return count || 0; });

    const [
      truePending,
      terminalDataUnavailable,
      ambiguousCount,
      resolvedLastHour,
      resolvedLastDay,
      retriedAtLeast3,
      cursorStalledRows,
      entryDayUnverifiable,
      dailyFallbackCount,
      oldestPendingRow,
      resolverRuns,
    ] = await Promise.all([
      countQuery(q => q.is('outcome', null).is('resolved_at', null)),
      countQuery(q => q.is('outcome', null).not('resolved_at', 'is', null).eq('resolution_method', 'data_unavailable')),
      countQuery(q => q.eq('outcome', 'AMBIGUOUS')),
      countQuery(q => q.not('resolved_at', 'is', null).gte('resolved_at', oneHourAgo)),
      countQuery(q => q.not('resolved_at', 'is', null).gte('resolved_at', oneDayAgo)),
      countQuery(q => q.is('outcome', null).is('resolved_at', null).gte('resolve_attempts', 3)),
      countQuery(q => q.is('outcome', null).is('resolved_at', null).not('last_walked_through', 'is', null)
        .lt('last_walked_through', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))),
      countQuery(q => q.eq('resolution_method', 'entry_day_daily_crossing_unverifiable')),
      countQuery(q => q.in('resolution_method', ['daily_bar_fallback_target', 'daily_bar_fallback_stop', 'daily_bar_both_crossed_ambiguous'])),
      supabase.from('signal_history').select('scanned_at, ticker, timeframe')
        .eq('is_lifecycle_primary', true).is('outcome', null).is('resolved_at', null)
        .order('scanned_at', { ascending: true }).limit(1).maybeSingle()
        .then(({ data, error }) => { if (error) throw error; return data; }),
      supabase.from('resolver_runs')
        .select('started_at, finished_at, mode, rows_fetched, rows_processed, resolved, still_open, data_unavailable, errors, circuit_broken, timed_out, tradier_calls, status_counts, deployment_sha')
        .order('started_at', { ascending: false }).limit(12)
        .then(({ data, error }) => {
          // Safe during a rolling deployment where API code may briefly arrive
          // before the migration. The response reports the missing telemetry.
          if (error?.code === '42P01' || error?.code === 'PGRST205') return [];
          if (error) throw error;
          return data || [];
        }),
    ]);

    const oldestPendingAgeHours = oldestPendingRow
      ? Math.round((Date.now() - new Date(oldestPendingRow.scanned_at).getTime()) / (1000 * 60 * 60))
      : null;

    const { healthStates, lastRunAgeMinutes } = deriveResolverRunHealth({
      runs: resolverRuns,
      truePending,
      cursorStalledRows,
      terminalDataUnavailable,
    });

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      healthStates,
      pending: {
        truePending,
        oldestPendingAgeHours,
        oldestPendingTicker: oldestPendingRow?.ticker || null,
        oldestPendingTimeframe: oldestPendingRow?.timeframe || null,
        retriedAtLeast3,
        cursorStalledRows,
      },
      terminal: {
        dataUnavailable: terminalDataUnavailable,
        ambiguous: ambiguousCount,
        entryDayUnverifiable,
      },
      throughput: {
        resolvedLastHour,
        resolvedLastDay,
      },
      resolverRuns: {
        lastRunAgeMinutes,
        recent: resolverRuns,
      },
      resolutionQuality: {
        dailyFallbackCount,
      },
    });
  } catch (e) {
    console.error('[admin/resolver-health] failed:', e.message);
    return res.status(500).json({ error: 'Failed to load resolver health' });
  }
};
