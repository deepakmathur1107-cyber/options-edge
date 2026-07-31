const { createClient } = require('@supabase/supabase-js');
const { getAuth, ADMIN_IDS } = require('../_lib/auth');
const { TRADIER_TOKEN, TRADIER_BASE } = require('../_lib/tradierClient');
const { deriveScannerHealth } = require('../_lib/adminHealth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Real per-service health checks for the Admin Monitor's System status card.
// Previously this was hardcoded `ok: true` for every service except
// Auto-scanner — confirmed live (screenshot, June 28) that all 5 dots
// showed green regardless of actual service health, since 4 of the 5
// were never actually checked. Each check below is read-only, cheap, and
// has its own timeout via AbortController so one slow/down service can't
// hang the whole /api/admin/metrics response — Promise.allSettled means a
// rejected check just reports unhealthy, not a 500 for the whole endpoint.
const HEALTH_TIMEOUT_MS = 4000;

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkTradier() {
  // /markets/clock is Tradier's lightest real endpoint — confirms auth +
  // connectivity without pulling a quote or chain.
  const res = await withTimeout(signal =>
    fetch(`${TRADIER_BASE}/markets/clock`, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      signal,
    })
  );
  return {
    ok: res.ok,
    status: res.ok ? 'operational' : 'degraded',
    detail: res.ok ? 'Authentication and market clock reachable' : `Market clock returned HTTP ${res.status}`,
  };
}

async function checkSupabase() {
  // Trivial single-row read against a table guaranteed to exist and stay
  // small — proves the DB connection/credentials work without scanning
  // anything meaningful. subscriptions is already queried elsewhere in
  // this same file, so it's known-present.
  const { error } = await supabase.from('subscriptions').select('clerk_id').limit(1);
  return {
    ok: !error,
    status: error ? 'degraded' : 'operational',
    detail: error ? 'Database health query failed' : 'Database query completed',
  };
}

async function checkRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, status: 'unconfigured', detail: 'Redis environment variables are missing' };
  const res = await withTimeout(signal =>
    fetch(`${url}/ping`, { headers: { Authorization: `Bearer ${token}` }, signal })
  );
  return {
    ok: res.ok,
    status: res.ok ? 'operational' : 'degraded',
    detail: res.ok ? 'Cache ping succeeded' : `Cache ping returned HTTP ${res.status}`,
  };
}

async function checkResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, status: 'unconfigured', detail: 'Resend API key is missing' };
  // GET /domains is read-only and doesn't send anything -- sending a real
  // test email on every dashboard load would be wasteful and would spam
  // the verified sender's send history for no reason.
  const res = await withTimeout(signal =>
    fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    })
  );
  return {
    ok: res.ok,
    status: res.ok ? 'operational' : 'degraded',
    detail: res.ok ? 'Email API authentication succeeded' : `Email API returned HTTP ${res.status}`,
  };
}

async function checkScanner() {
  // Correcting an assumption made while writing checkSystemHealth above:
  // systemOk (the field this previously reused) was hardcoded `true` in
  // this file's entire history -- it was never a real scanner signal, so
  // Auto-scanner's dot was exactly as fake as the other four, not "already
  // real" as initially assumed. Real signal instead: has scan_results
  // gotten a write recently? Cron runs every 15 min during market hours
  // (10-22 UTC, Mon-Fri per vercel.json) -- a 45-min staleness threshold
  // gives 3 missed ticks of slack before flagging unhealthy, so a single
  // slow run doesn't false-positive. NOTE: this will correctly show stale
  // outside market hours/weekends -- that's accurate, not a bug, but
  // worth knowing if this ever gets checked on a Sunday and looks "down."
  const { data, error } = await supabase
    .from('scan_results')
    .select('scanned_at')
    .order('scanned_at', { ascending: false })
    .limit(1);
  return deriveScannerHealth({ lastObservedAt: error || !data?.length ? null : data[0].scanned_at });
}

async function checkSystemHealth() {
  const [tradier, supabaseOk, redis, resend, scanner] = await Promise.allSettled([
    checkTradier(), checkSupabase(), checkRedis(), checkResend(), checkScanner(),
  ]);
  const normalize = (result, fallback) => result.status === 'fulfilled'
    ? { ...result.value, checkedAt: new Date().toISOString() }
    : { ok: false, status: 'degraded', detail: fallback, checkedAt: new Date().toISOString() };
  const details = {
    tradier: normalize(tradier, 'Market Data API check failed or timed out'),
    supabase: normalize(supabaseOk, 'Database check failed or timed out'),
    redis: normalize(redis, 'Cache check failed or timed out'),
    resend: normalize(resend, 'Email API check failed or timed out'),
    scanner: normalize(scanner, 'Scanner freshness check failed or timed out'),
  };
  return {
    summary: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.ok])),
    details,
  };
}

async function getRecentClerkProfiles(clerkIds) {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key || !clerkIds.length) return new Map();
  const entries = await Promise.all(clerkIds.slice(0, 8).map(async clerkId => {
    try {
      const response = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) return [clerkId, null];
      const user = await response.json();
      const addresses = user.email_addresses || [];
      const primary = addresses.find(address => address.id === user.primary_email_address_id) || addresses[0];
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
      return [clerkId, {
        name: fullName || user.username || null,
        email: primary?.email_address || null,
      }];
    } catch (error) {
      console.error('[admin/metrics] Clerk profile lookup failed for recent user:', error.message);
      return [clerkId, null];
    }
  }));
  return new Map(entries);
}

module.exports = async (req, res) => {
  // FIX: was '*' — admin/revenue data must never be readable cross-origin.
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com');
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
    // Kicked off immediately, awaited near the end -- runs concurrently
    // with the DB queries below instead of adding its own latency on top.
    const healthPromise = checkSystemHealth();

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

    // Recent signups (last 8). Clerk is the identity source of truth; never
    // expose a truncated internal Clerk ID as the user's display name.
    const recentProfiles = await getRecentClerkProfiles(subs.slice(0, 8).map(s => s.clerk_id).filter(Boolean));
    const recentUsers = subs.slice(0, 8).map(s => {
      const email = emailMap[s.clerk_id] || s.clerk_id?.slice(0, 16) + '…';
      const profile = recentProfiles.get(s.clerk_id);
      const safeEmail = profile?.email || (email?.includes('@') ? email : null);
      const displayName = profile?.name || (safeEmail ? safeEmail.split('@')[0] : 'New user');
      const daysLeft = s.current_period_end
        ? Math.max(0, Math.ceil((new Date(s.current_period_end) - now) / (1000 * 60 * 60 * 24)))
        : null;
      return {
        initials: getInitials(displayName),
        name:     displayName,
        email:    safeEmail,
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

    const systemHealthResult = await healthPromise;
    const systemHealth = systemHealthResult.summary;

    return res.status(200).json({
      totalUsers, paidUsers, trialUsers,
      activeToday, newThisWeek, expiringTrials,
      signupsByDay, recentUsers, features,
      systemHealth,
      systemHealthDetails: systemHealthResult.details,
      // All 5 services are now genuinely checked (see checkSystemHealth) —
      // previously this was hardcoded true unconditionally, including for
      // the scanner, which this comment's earlier draft incorrectly
      // assumed was already real.
      systemOk: Object.values(systemHealth).every(Boolean),
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
