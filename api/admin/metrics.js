const { createClient } = require('@supabase/supabase-js');
const { isAdminUser } = require('../_lib/adminBypass');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  const adminCheck = await isAdminUser(token);
  if (!adminCheck) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);

    const startOf14Days = new Date(now);
    startOf14Days.setDate(now.getDate() - 13);
    startOf14Days.setHours(0, 0, 0, 0);

    const trialExpiryCutoff = new Date(now);
    trialExpiryCutoff.setHours(now.getHours() + 48);

    const [
      allSubsResult,
      activeTodayResult,
      newThisWeekResult,
      expiringResult,
      signupTrendResult,
      recentUsersResult,
      featureUsageResult,
    ] = await Promise.all([
      supabase.from('subscriptions').select('status, plan, created_at, trial_end'),
      supabase.from('subscriptions').select('user_id').gte('last_seen', startOfToday.toISOString()),
      supabase.from('subscriptions').select('user_id').gte('created_at', startOfWeek.toISOString()),
      supabase
        .from('subscriptions')
        .select('user_id, trial_end')
        .eq('status', 'trialing')
        .lte('trial_end', trialExpiryCutoff.toISOString())
        .gte('trial_end', now.toISOString()),
      supabase
        .from('subscriptions')
        .select('created_at')
        .gte('created_at', startOf14Days.toISOString())
        .order('created_at', { ascending: true }),
      supabase
        .from('subscriptions')
        .select('email, status, trial_end, created_at')
        .order('created_at', { ascending: false })
        .limit(8),
      supabase
        .from('feature_usage')
        .select('feature, user_id')
        .limit(5000),
    ]);

    const allSubs = allSubsResult.data || [];
    const totalUsers = allSubs.length;
    const paidUsers = allSubs.filter(s => s.status === 'active').length;
    const trialUsers = allSubs.filter(s => s.status === 'trialing').length;
    const activeToday = (activeTodayResult.data || []).length;
    const newThisWeek = (newThisWeekResult.data || []).length;
    const expiringTrials = (expiringResult.data || []).length;

    const signupsByDay = buildSignupTrend(signupTrendResult.data || [], startOf14Days);

    const recentUsers = (recentUsersResult.data || []).map(u => ({
      initials: getInitials(u.email),
      name: u.email,
      plan: u.status === 'active' ? 'paid' : u.status === 'trialing' ? 'trial' : 'free',
      daysLeft: u.trial_end
        ? Math.max(0, Math.ceil((new Date(u.trial_end) - now) / (1000 * 60 * 60 * 24)))
        : null,
    }));

    const features = buildFeatureUsage(featureUsageResult.data || [], totalUsers);

    return res.status(200).json({
      totalUsers,
      paidUsers,
      trialUsers,
      activeToday,
      newThisWeek,
      expiringTrials,
      signupsByDay,
      recentUsers,
      features,
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
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    if (day in buckets) buckets[day]++;
  }
  return Object.values(buckets);
}

function buildFeatureUsage(rows, totalUsers) {
  if (!rows.length || !totalUsers) {
    return [
      { name: 'Scanner', pct: 0 },
      { name: 'Morning brief', pct: 0 },
      { name: 'Email alerts', pct: 0 },
      { name: 'Trade log', pct: 0 },
      { name: 'S&R levels', pct: 0 },
    ];
  }
  const featureNames = ['Scanner', 'Morning brief', 'Email alerts', 'Trade log', 'S&R levels'];
  const featureKeys = ['scanner', 'morning_brief', 'email_alerts', 'trade_log', 'sr_levels'];
  return featureNames.map((name, i) => {
    const uniqueUsers = new Set(
      rows.filter(r => r.feature === featureKeys[i]).map(r => r.user_id)
    ).size;
    return { name, pct: Math.round((uniqueUsers / totalUsers) * 100) };
  });
}

function getInitials(email) {
  if (!email) return '??';
  const local = email.split('@')[0];
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}
