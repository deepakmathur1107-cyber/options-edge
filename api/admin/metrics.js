const { createClient } = require('@supabase/supabase-js');
const { getAuth, ADMIN_IDS } = require('../_lib/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  // FIX: was '*' — admin/revenue data must never be readable cross-origin.
  res.setHeader('Access-Control-Allow-Origin', 'https://optionsedgeflow.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // FIX: previously decoded the JWT payload with no signature verification —
  // anyone could forge a token with sub = an admin Clerk ID and get full access.
  // getAuth() does real Clerk JWKS signature verification + expiry check.
  const { clerkId, isAdmin, error: authErr } = await getAuth(req);
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' });
  if (!isAdmin && !ADMIN_IDS.includes(clerkId)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const now = new Date();
    const startOfToday  = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek   = new Date(now); startOfWeek.setDate(now.getDate() - 7);
    const startOf14Days = new Date(now); startOf14Days.setDate(now.getDate() - 13); startOf14Days.setHours(0, 0, 0, 0);
    const in48Hours     = new Date(now); in48Hours.setHours(now.getHours() + 48);

    // All subscriptions — source of truth
    const { data: allSubs, error: subsErr } = await supabase
      .from('subscriptions')
      .select('clerk_id, status, plan, created_at, current_period_end')
      .order('created_at', { ascending: false });

    if (subsErr) return res.status(500).json({ error: subsErr.message });

    const subs = allSubs || [];
    const totalUsers  = subs.length;
    const paidUsers   = subs.filter(s => s.status === 'active').length;
    const trialUsers  = subs.filter(s => s.status === 'trialing').length;
    const newThisWeek = subs.filter(s => new Date(s.created_at) >= startOfWeek).length;

    // Trials expiring in next 48h
    const expiringTrials = subs.filter(s =>
      s.status === 'trialing' &&
      s.current_period_end &&
      new Date(s.current_period_end) >= now &&
      new Date(s.current_period_end) <= in48Hours
    ).length;

    // Signup trend — last 14 days
    const signupsByDay = buildSignupTrend(
      subs.filter(s => new Date(s.created_at) >= startOf14Days),
      startOf14Days
    );

    // Get emails from alert_prefs (optional — graceful fallback)
    const clerkIds = subs.map(s => s.clerk_id).filter(Boolean);
    const { data: prefs } = await supabase
      .from('alert_prefs')
      .select('clerk_user_id, alert_email')
      .in('clerk_user_id', clerkIds);

    const emailMap = {};
    (prefs || []).forEach(p => { if (p.alert_email) emailMap[p.clerk_user_id] = p.alert_email; });

    // Recent signups (last 8)
    const recentUsers = subs.slice(0, 8).map(s => {
      const email = emailMap[s.clerk_id] || s.clerk_id?.slice(0, 16) + '…';
      const daysLeft = s.current_period_end
        ? Math.max(0, Math.ceil((new Date(s.current_period_end) - now) / (1000 * 60 * 60 * 24)))
        : null;
      return {
        initials: getInitials(email),
        name:     email,
        plan:     s.status === 'active' ? 'paid' : s.status === 'trialing' ? 'trial' : 'free',
        daysLeft,
      };
    });

    // Feature usage — graceful if table doesn't exist
    let features = defaultFeatures();
    try {
      const { data: fuRows } = await supabase
        .from('feature_usage')
        .select('feature, clerk_user_id')
        .limit(5000);
      if (fuRows?.length) features = buildFeatureUsage(fuRows, totalUsers);
    } catch (_) {}

    // active_today — use updated_at as proxy for last seen
    const activeToday = subs.filter(s =>
      s.updated_at && new Date(s.updated_at) >= startOfToday
    ).length;

    return res.status(200).json({
      totalUsers, paidUsers, trialUsers,
      activeToday, newThisWeek, expiringTrials,
      signupsByDay, recentUsers, features,
      systemOk: true,
      generatedAt: now.toISOString(),
    });

  } catch (err) {
    console.error('[admin/metrics] error:', err);
    return res.status(500).json({ error: 'Failed to load metrics', detail: err.message });
  }
};

function buildSignupTrend(rows, startDate) {
  const buckets = {};
  for (let i = 0; i < 14; i++) {
    const d = new Date(startDate); d.setDate(startDate.getDate() + i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of rows) {
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    if (day in buckets) buckets[day]++;
  }
  return Object.values(buckets);
}

function defaultFeatures() {
  return [
    { name: 'Scanner',       pct: 0 },
    { name: 'Morning brief', pct: 0 },
    { name: 'Email alerts',  pct: 0 },
    { name: 'Trade log',     pct: 0 },
    { name: 'S&R levels',    pct: 0 },
  ];
}

function buildFeatureUsage(rows, totalUsers) {
  const featureNames = ['Scanner', 'Morning brief', 'Email alerts', 'Trade log', 'S&R levels'];
  const featureKeys  = ['scanner', 'morning_brief', 'email_alerts', 'trade_log', 'sr_levels'];
  if (!rows.length || !totalUsers) return defaultFeatures();
  return featureNames.map((name, i) => {
    const unique = new Set(rows.filter(r => r.feature === featureKeys[i]).map(r => r.clerk_user_id)).size;
    return { name, pct: Math.round((unique / totalUsers) * 100) };
  });
}

function getInitials(str) {
  if (!str) return '??';
  const local = str.includes('@') ? str.split('@')[0] : str;
  const parts = local.split(/[._-]/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : local.slice(0, 2).toUpperCase();
}
