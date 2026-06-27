// api/admin/cluster-distribution.js
//
// GET /api/admin/cluster-distribution?days=14&minSize=3
//
// Item 4 tuning support. Turns the manual SQL query from
// item4-cluster-tuning-check.sql (written when CLUSTER_MIN_COUNT was first
// set, re-run and corrected once already after discovering it originally
// targeted the wrong table) into a real, reusable admin endpoint — load a
// page instead of writing SQL by hand each time someone wants to check
// whether the threshold still looks right.
//
// Deliberately does NOT compute or suggest a new threshold value — this
// endpoint surfaces the raw distribution; the actual judgment call (is 4
// too sensitive, too lax, fine) stays a human decision, same as every
// other product-judgment call this session. Returns data, not a verdict.
//
// IMPORTANT CAVEAT, surfaced directly in the response (not just a code
// comment): signal_history only began accumulating recently (Phase 0-3),
// so a `days` request larger than how much real history actually exists
// will silently just return however many days ARE there — the response
// includes `distinctDaysFound` so the caller/UI can tell "asked for 14,
// only found 2" apart from "asked for 14, got 14."

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
    const days    = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    // minSize defaults to 3, ONE BELOW the live CLUSTER_MIN_COUNT (4) — same
    // reasoning as the original manual query: showing what's just under the
    // current bar, not only what already clears it, is what actually lets
    // a human judge whether the bar is in the right place.
    const minSize = Math.max(1, parseInt(req.query.minSize, 10) || 3);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await supabase
      .from('signal_history')
      .select('scanned_at, sector, option_type, ticker')
      .gte('scanned_at', since.toISOString())
      .not('sector', 'is', null);

    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];

    // Group by (day, sector, direction) -> Set of distinct tickers, same
    // grouping logic as the original manual query, just done in JS instead
    // of SQL GROUP BY/COUNT(DISTINCT) since we already need the raw rows
    // for the distinctDaysFound calculation below anyway.
    const groups = new Map();
    const distinctDays = new Set();
    for (const r of rows) {
      const day = r.scanned_at.slice(0, 10);
      distinctDays.add(day);
      const direction = r.option_type === 'put' ? 'put' : 'call';
      const key = `${day}|${r.sector}|${direction}`;
      if (!groups.has(key)) groups.set(key, { day, sector: r.sector, direction, tickers: new Set() });
      groups.get(key).tickers.add(r.ticker);
    }

    const clusters = [...groups.values()]
      .map(g => ({ day: g.day, sector: g.sector, direction: g.direction, clusterSize: g.tickers.size }))
      .filter(g => g.clusterSize >= minSize)
      .sort((a, b) => b.day.localeCompare(a.day) || b.clusterSize - a.clusterSize);

    return res.status(200).json({
      requestedDays: days,
      distinctDaysFound: distinctDays.size,
      // Explicit, honest flag rather than making the caller infer this from
      // comparing the two numbers above themselves.
      lessHistoryThanRequested: distinctDays.size < days,
      minSize,
      liveClusterMinCount: 4, // the actual constant in api/scan-cache.js — kept here as a labeled reference point, NOT read from that file live (would require a cross-module import this endpoint doesn't otherwise need); update this literal if that constant is ever changed.
      clusters,
    });
  } catch (e) {
    console.error('[admin/cluster-distribution] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
