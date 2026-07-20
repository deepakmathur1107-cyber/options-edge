// api/admin/shadow-data.js
// Added 2026-07-21. Read-only visibility into everything built as "shadow"
// this week (Phase 1 vertical spreads, Phase 1b resolver, Phase 2 technical
// reweight + news signal, plus the historical spread backfill) — none of
// which has ever had a UI surface before. This endpoint changes NOTHING
// about scoring or the live product; it only reads and summarizes columns
// that already exist. Same auth pattern as metrics.js (real Clerk JWKS
// verification, not a forgeable token).

const { createClient } = require('@supabase/supabase-js');
const { getAuth, ADMIN_IDS } = require('../_lib/auth');

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
    const swingLeapDeep = ['Swing (21–45 DTE)', 'LEAP (90–180 DTE)', 'Deep LEAP (180–365 DTE)'];

    const [
      liveSpreadCoverage,
      recentSpreads,
      reweightSample,
      newsCoverage,
      historicalBackfillProgress,
      historicalResults,
    ] = await Promise.all([
      // Live-forward shadow spread: how much of the Swing+ population has one
      supabase.from('signal_history')
        .select('id', { count: 'exact', head: true })
        .not('shadow_vertical_spread', 'is', null),
      // A handful of recent real entries, for a human to spot-check
      supabase.from('signal_history')
        .select('ticker, timeframe, option_type, scanned_at, shadow_vertical_spread')
        .not('shadow_vertical_spread', 'is', null)
        .order('scanned_at', { ascending: false })
        .limit(10),
      // Technical reweight: recent live-vs-shadow score deltas
      supabase.from('signal_history')
        .select('ticker, timeframe, score, shadow_technical_reweight_score, scanned_at')
        .not('shadow_technical_reweight_score', 'is', null)
        .order('scanned_at', { ascending: false })
        .limit(10),
      // News signal coverage (Quick only, by design)
      supabase.from('signal_history')
        .select('id', { count: 'exact', head: true })
        .not('shadow_recent_news_count', 'is', null),
      // Historical backfill progress
      supabase.from('signal_history')
        .select('id', { count: 'exact', head: true })
        .not('historical_shadow_spread_outcome', 'is', null),
      // Historical backfill results so far (the actual early read, caveated
      // in the UI as preliminary/single-cohort)
      supabase.from('signal_history')
        .select('option_type, historical_shadow_spread_outcome, historical_shadow_spread_pnl_pct, outcome')
        .not('historical_shadow_spread_outcome', 'is', null)
        .in('timeframe', swingLeapDeep),
    ]);

    // Aggregate the historical comparison server-side so the client doesn't
    // need to — small dataset, cheap to reduce here.
    const historicalByType = {};
    for (const row of (historicalResults.data || [])) {
      const key = row.option_type;
      if (!historicalByType[key]) historicalByType[key] = { n: 0, knownN: 0, pnlSum: 0, fullWin: 0, partial: 0, totalLoss: 0 };
      const b = historicalByType[key];
      b.n++;
      if (row.historical_shadow_spread_outcome !== 'unknown' && row.historical_shadow_spread_pnl_pct != null) {
        b.knownN++;
        b.pnlSum += row.historical_shadow_spread_pnl_pct;
        if (row.historical_shadow_spread_outcome === 'FULL_WIN') b.fullWin++;
        else if (row.historical_shadow_spread_outcome === 'PARTIAL') b.partial++;
        else if (row.historical_shadow_spread_outcome === 'TOTAL_LOSS') b.totalLoss++;
      }
    }
    const historicalSummary = Object.entries(historicalByType).map(([optType, b]) => ({
      optType,
      n: b.n,
      knownN: b.knownN,
      avgPnlPct: b.knownN ? Math.round((b.pnlSum / b.knownN) * 10) / 10 : null,
      fullWin: b.fullWin, partial: b.partial, totalLoss: b.totalLoss,
    }));

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      liveSpread: {
        totalWithSpread: liveSpreadCoverage.count || 0,
        recent: recentSpreads.data || [],
      },
      technicalReweight: {
        recent: (reweightSample.data || []).map(r => ({
          ...r,
          delta: r.shadow_technical_reweight_score - r.score,
        })),
      },
      newsSignal: {
        totalWithData: newsCoverage.count || 0,
      },
      historicalBackfill: {
        resolvedCount: historicalBackfillProgress.count || 0,
        summary: historicalSummary,
        caveat: 'Preliminary — single historical cohort (one calendar week of entries), coarser methodology than live-forward data (computed strikes, daily-close price proxy, no chain liquidity verification). Not sufficient to validate anything on its own.',
      },
    });
  } catch (e) {
    console.error('[admin/shadow-data] failed:', e.message);
    return res.status(500).json({ error: 'Failed to load shadow data' });
  }
};
