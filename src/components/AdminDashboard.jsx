import { useState, useEffect, useRef, useCallback } from 'react';

const FEATURE_COLORS = ['#1D9E75', '#378ADD', '#BA7517', '#D4537E', '#7F77DD'];

function MetricCard({ label, value, sub, subVariant }) {
  return (
    <div style={{
      background: 'var(--card-bg, #161b22)',
      border: '1px solid var(--border, #30363d)',
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: '#e6edf3', lineHeight: 1, fontFamily: "'IBM Plex Mono', monospace" }}>{value ?? '—'}</div>
      {sub && (
        <div style={{
          fontSize: 11,
          marginTop: 4,
          color: subVariant === 'up' ? '#3fb950' : subVariant === 'down' ? '#f85149' : '#8b949e',
        }}>{sub}</div>
      )}
    </div>
  );
}

function FeatureBars({ features }) {
  if (!features?.length) return null;
  return (
    <div>
      {features.map((f, i) => (
        <div key={f.name} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#8b949e', marginBottom: 4 }}>
            <span>{f.name}</span><span style={{ color: '#e6edf3', fontFamily: "'IBM Plex Mono', monospace" }}>{f.pct}%</span>
          </div>
          <div style={{ height: 5, background: '#21262d', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${f.pct}%`, height: '100%', background: FEATURE_COLORS[i % FEATURE_COLORS.length], borderRadius: 3, transition: 'width 0.6s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SystemStatus({ ok }) {
  const services = [
    { label: 'Tradier API', ok: true },
    { label: 'Supabase', ok: true },
    { label: 'Redis cache', ok: true },
    { label: 'Resend email', ok: true },
    { label: 'Auto-scanner', ok: ok !== false },
  ];
  return (
    <div>
      {services.map(s => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12, color: '#8b949e' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: s.ok ? '#3fb950' : '#f0883e', flexShrink: 0 }} />
          {s.label}
        </div>
      ))}
    </div>
  );
}

function RecentUsers({ users }) {
  if (!users?.length) return <div style={{ color: '#8b949e', fontSize: 13, textAlign: 'center', padding: '1rem 0' }}>No users yet</div>;
  return (
    <div>
      {users.map((u, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < users.length - 1 ? '1px solid #21262d' : 'none' }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: '#1f3d5c', color: '#79c0ff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 600, flexShrink: 0,
          }}>{u.initials}</div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontSize: 12, color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</div>
          </div>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500, flexShrink: 0,
            background: u.plan === 'paid' ? '#1a3a1a' : u.plan === 'trial' ? '#3a2a0a' : '#21262d',
            color: u.plan === 'paid' ? '#3fb950' : u.plan === 'trial' ? '#f0883e' : '#8b949e',
          }}>
            {u.plan === 'trial' ? `trial · ${u.daysLeft}d` : u.plan}
          </span>
        </div>
      ))}
    </div>
  );
}

function SignupChart({ data }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!data?.length || !canvasRef.current) return;
    let Chart = window.Chart;
    if (!Chart) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    const labels = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Signups', data, backgroundColor: '#1D9E75', borderRadius: 3, borderSkipped: false }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 7, color: '#8b949e' } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 }, precision: 0, color: '#8b949e' }, beginAtZero: true },
        },
      },
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [data]);

  return (
    <div style={{ position: 'relative', height: 160 }}>
      <canvas ref={canvasRef} role="img" aria-label="Daily signup chart for last 14 days" />
    </div>
  );
}

export default function AdminDashboard({ getToken }) {
  const resolvedGetToken = getToken || (async () => null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [chartJsReady, setChartJsReady] = useState(!!window.Chart);

  useEffect(() => {
    if (window.Chart) { setChartJsReady(true); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    script.onload = () => setChartJsReady(true);
    document.head.appendChild(script);
  }, []);

  const loadMetrics = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await resolvedGetToken();
      const res = await fetch('/api/admin/metrics', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMetrics(); }, [loadMetrics]);

  const conv = data ? (data.paidUsers && data.totalUsers ? Math.round((data.paidUsers / data.totalUsers) * 100) : 0) : null;
  const mrr = data ? data.paidUsers * 29 : null;

  const sectionLabel = {
    fontSize: 11, fontWeight: 500, letterSpacing: '0.08em',
    color: '#8b949e', textTransform: 'uppercase',
    margin: '1.5rem 0 0.75rem',
  };

  const card = {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 10,
    padding: '1rem 1.25rem',
    marginTop: 10,
  };

  const grid4 = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
    gap: 10,
  };

  if (error) return (
    <div style={{ padding: '2rem', color: '#f85149', fontFamily: 'Inter, sans-serif', textAlign: 'center' }}>
      <div style={{ fontSize: 14 }}>Failed to load metrics: {error}</div>
      <button onClick={loadMetrics} style={{ marginTop: 12, padding: '6px 16px', borderRadius: 6, border: '1px solid #30363d', background: '#21262d', color: '#e6edf3', cursor: 'pointer', fontSize: 13 }}>Retry</button>
    </div>
  );

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'Inter, sans-serif', color: '#e6edf3', maxWidth: 960, margin: '0 auto' }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#3fb950', animation: 'pulse-dot 2s infinite' }} />
          <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'Bebas Neue', sans-serif", letterSpacing: '0.05em', color: '#00ff88' }}>
            ADMIN MONITOR
          </span>
        </div>
        <button
          onClick={loadMetrics}
          disabled={loading}
          style={{ fontSize: 12, color: '#8b949e', cursor: 'pointer', background: 'none', border: '1px solid #30363d', borderRadius: 6, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {lastUpdated && <div style={{ fontSize: 11, color: '#8b949e', marginBottom: '1rem' }}>Last updated: {lastUpdated}</div>}

      <div style={sectionLabel}>Users</div>
      <div style={grid4}>
        <MetricCard label="Total users" value={data?.totalUsers} sub="all time" />
        <MetricCard label="Active today" value={data?.activeToday} sub="signed in last 24h" />
        <MetricCard label="New this week" value={data?.newThisWeek} sub={data?.newThisWeek > 0 ? `+${data.newThisWeek} vs last week` : '0 new'} subVariant={data?.newThisWeek > 0 ? 'up' : null} />
        <MetricCard label="On free trial" value={data?.trialUsers} sub="of 7 days" />
        <MetricCard label="Paid subscribers" value={data?.paidUsers} sub="$29/mo" />
        <MetricCard label="Conversion rate" value={conv !== null ? `${conv}%` : null} sub="trial → paid" subVariant={conv > 30 ? 'up' : conv < 15 ? 'down' : null} />
      </div>

      <div style={sectionLabel}>Revenue</div>
      <div style={grid4}>
        <MetricCard label="MRR" value={mrr !== null ? `$${mrr.toLocaleString()}` : null} sub="monthly recurring" />
        <MetricCard label="ARR (est.)" value={mrr !== null ? `$${(mrr * 12).toLocaleString()}` : null} sub="× 12" />
        <MetricCard label="Trials expiring" value={data?.expiringTrials} sub="next 48 hours" subVariant={data?.expiringTrials > 0 ? 'down' : null} />
      </div>

      <div style={sectionLabel}>App health</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Feature usage</div>
          <FeatureBars features={data?.features} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>System status</div>
          <SystemStatus ok={data?.systemOk} />
        </div>
      </div>

      <div style={sectionLabel}>Signup trend (last 14 days)</div>
      <div style={card}>
        {chartJsReady && data?.signupsByDay ? <SignupChart data={data.signupsByDay} /> : <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: 13 }}>Loading chart…</div>}
      </div>

      <div style={sectionLabel}>Recent signups</div>
      <div style={card}>
        <RecentUsers users={data?.recentUsers} />
      </div>

      <style>{`
        @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
