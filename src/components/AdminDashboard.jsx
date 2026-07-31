import { useState, useEffect, useRef, useCallback } from 'react';

// fmtLocalTime — same pattern as App.jsx/MorningBrief.jsx (2026-06-29):
// auto-detects the viewer's own timezone and labels it explicitly, instead
// of a bare toLocaleTimeString() with no zone shown at all. Admin-only
// page, so lower stakes than the user-facing fixes, but the same
// unlabeled-time bug, worth closing for consistency rather than leaving
// one inconsistent exception in the codebase.
const TZ_ABBREV = { 'America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Los_Angeles':'PT' };
function fmtLocalTime(date) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${timeStr} ${TZ_ABBREV[tz] || tz}`;
}

// Categorical colors for the feature-usage bars — deliberately NOT theme
// tokens. These distinguish 5 different features from each other (a legend),
// not bullish/bearish/neutral states, so forcing them through C.green/C.blue
// etc. would reduce how distinguishable they are from one another. Picked to
// sit reasonably within both the dark (warm slate) and light (cream) themes.
const FEATURE_COLORS = ['#1D9E75', '#378ADD', '#BA7517', '#D4537E', '#7F77DD'];

function MetricCard({ label, value, sub, subVariant, C }) {
  return (
    <div style={{
      background: C.cardAlt,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: C.text, lineHeight: 1, fontFamily: "'IBM Plex Mono', monospace" }}>{value ?? '—'}</div>
      {sub && (
        <div style={{
          fontSize: 11,
          marginTop: 4,
          color: subVariant === 'up' ? C.green : subVariant === 'down' ? C.red : C.dim,
        }}>{sub}</div>
      )}
    </div>
  );
}

function FeatureBars({ features, C }) {
  if (!features?.length) return null;
  return (
    <div>
      {features.map((f, i) => (
        <div key={f.name} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.dim, marginBottom: 4 }}>
            <span>{f.name}</span><span style={{ color: C.text, fontFamily: "'IBM Plex Mono', monospace" }}>{f.pct}%</span>
          </div>
          <div style={{ height: 5, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${f.pct}%`, height: '100%', background: FEATURE_COLORS[i % FEATURE_COLORS.length], borderRadius: 3, transition: 'width 0.6s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SystemStatus({ health, details, C }) {
  // health (systemHealth from the API) now reflects real checks for all 5
  // services -- confirmed live (screenshot, June 28) that all 5 dots
  // previously showed green unconditionally regardless of actual status,
  // since none of them were genuinely checked, including Auto-scanner
  // (an earlier draft of this fix incorrectly assumed scanner was already
  // real via the old systemOk field -- it wasn't; systemOk was hardcoded
  // true in this file's entire history).
  const services = [
    { key: 'tradier', label: 'Market Data API', ok: health?.tradier !== false },
    { key: 'supabase', label: 'Supabase',        ok: health?.supabase !== false },
    { key: 'redis', label: 'Redis cache',     ok: health?.redis !== false },
    { key: 'resend', label: 'Resend email',    ok: health?.resend !== false },
    { key: 'scanner', label: 'Auto-scanner',    ok: health?.scanner !== false },
  ];
  return (
    <div>
      {services.map(s => {
        const detail = details?.[s.key]
        const paused = detail?.status === 'paused'
        const statusColor = !s.ok ? C.red : paused ? C.blue : C.green
        const lastObserved = detail?.lastObservedAt
          ? new Date(detail.lastObservedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : null
        return (
        <div key={s.label} style={{ padding: '7px 0', borderBottom: `1px solid ${C.borderDim}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
            <span style={{ color: C.text, flex: 1 }}>{s.label}</span>
            <span style={{ color: statusColor, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase' }}>
              {detail?.status || (s.ok ? 'operational' : 'degraded')}
            </span>
          </div>
          {detail?.detail && <div style={{ color: C.dim, fontSize: 10.5, margin: '3px 0 0 14px', lineHeight: 1.45 }}>
            {detail.detail}{lastObserved ? ` · Last result ${lastObserved}` : ''}
          </div>}
        </div>
      )})}
    </div>
  );
}

function RecentUsers({ users, C }) {
  if (!users?.length) return <div style={{ color: C.dim, fontSize: 13, textAlign: 'center', padding: '1rem 0' }}>No users yet</div>;
  return (
    <div>
      {users.map((u, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < users.length - 1 ? `1px solid ${C.borderDim}` : 'none' }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: `${C.blue}25`, color: C.blue,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 600, flexShrink: 0,
          }}>{u.initials}</div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</div>
            {u.email && u.email !== u.name && (
              <div style={{ fontSize: 10.5, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{u.email}</div>
            )}
          </div>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500, flexShrink: 0,
            background: u.plan === 'paid' ? `${C.green}20` : u.plan === 'trial' ? `${C.orange}20` : C.cardAlt,
            color: u.plan === 'paid' ? C.green : u.plan === 'trial' ? C.orange : C.dim,
          }}>
            {u.plan === 'trial' ? `trial · ${u.daysLeft}d` : u.plan}
          </span>
        </div>
      ))}
    </div>
  );
}

function SignupChart({ data, C }) {
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
        datasets: [{ label: 'Signups', data, backgroundColor: C.green, borderRadius: 3, borderSkipped: false }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 7, color: C.dim } },
          y: { grid: { color: C.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 10 }, precision: 0, color: C.dim }, beginAtZero: true },
        },
      },
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, C.green, C.dim, C.isDark]);

  return (
    <div style={{ position: 'relative', height: 160 }}>
      <canvas ref={canvasRef} role="img" aria-label="Daily signup chart for last 14 days" />
    </div>
  );
}

export default function AdminDashboard({ getToken, theme }) {
  const C = theme || {}
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
      setLastUpdated(fmtLocalTime(new Date()));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMetrics(); }, [loadMetrics]);

  const conv = data ? (data.paidUsers && data.totalUsers ? Math.round((data.paidUsers / data.totalUsers) * 100) : 0) : null;
  // ROUGH ESTIMATE ONLY — actual pricing lives in Stripe (STRIPE_PRICE_ID_PRO),
  // not in this codebase, so this can't reflect real per-user pricing, mixed
  // tiers, discounts, or annual plans. A correct fix would pull actual MRR
  // from Stripe's API rather than guessing a flat per-user rate client-side.
  // Labeled "(est.)" in the UI below so it's never mistaken for real revenue.
  const ASSUMED_FLAT_RATE = 19;
  const mrr = data ? data.paidUsers * ASSUMED_FLAT_RATE : null;

  const sectionLabel = {
    fontSize: 11, fontWeight: 500, letterSpacing: '0.08em',
    color: C.dim, textTransform: 'uppercase',
    margin: '1.5rem 0 0.75rem',
  };

  const card = {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: '1rem 1.25rem',
    marginTop: 10,
  };

  const grid4 = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
    gap: 10,
  };

  // Two-column pairing for App Health and Signup Trend/Recent Signups --
  // auto-fit/minmax instead of a fixed '1fr 1fr' so it collapses to one
  // column on narrow viewports automatically, the same responsive pattern
  // grid4 already uses above, rather than needing a manual breakpoint.
  const grid2 = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 10,
  };

  if (error) return (
    <div style={{ padding: '2rem', color: C.red, fontFamily: 'Inter, sans-serif', textAlign: 'center' }}>
      <div style={{ fontSize: 14 }}>Failed to load metrics: {error}</div>
      <button onClick={loadMetrics} style={{ marginTop: 12, padding: '6px 16px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.cardAlt, color: C.text, cursor: 'pointer', fontSize: 13 }}>Retry</button>
    </div>
  );

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'Inter, sans-serif', color: C.text, maxWidth: 1320, margin: '0 auto' }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: C.green, animation: 'pulse-dot 2s infinite' }} />
          <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'Fraunces',serif", letterSpacing: '0.05em', color: C.green }}>
            ADMIN MONITOR
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Compact health summary -- the one thing worth seeing before any
              scrolling on a daily check. Previously System Status only
              appeared at the bottom of App Health, several screens down. */}
          {data?.systemHealth && (() => {
            const services = Object.values(data.systemHealth)
            const healthyCount = services.filter(Boolean).length
            const allHealthy = healthyCount === services.length
            return (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.dim,
                padding: '4px 10px', border: `1px solid ${C.border}`, borderRadius: 6,
              }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: allHealthy ? C.green : C.orange }} />
                {allHealthy ? 'All systems normal' : `${healthyCount}/${services.length} systems normal`}
              </div>
            )
          })()}
          <button
            onClick={loadMetrics}
            disabled={loading}
            style={{ fontSize: 12, color: C.dim, cursor: 'pointer', background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      {lastUpdated && <div style={{ fontSize: 11, color: C.dim, marginBottom: '1rem' }}>Last updated: {lastUpdated}</div>}

      <div style={{...card,marginTop:8,borderColor:(data?.expiringTrials>0||Object.values(data?.systemHealth||{}).some(value=>!value))?`${C.orange}70`:`${C.green}55`}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:10}}>
          <div><div style={{fontSize:14,fontWeight:700}}>Action required</div><div style={{fontSize:12,color:C.dim,marginTop:2}}>Exceptions first; healthy systems stay quiet.</div></div>
          <span style={{fontSize:11,fontWeight:700,color:(data?.expiringTrials>0||Object.values(data?.systemHealth||{}).some(value=>!value))?C.orange:C.green}}>
            {(data?.expiringTrials||0)+Object.values(data?.systemHealth||{}).filter(value=>!value).length} OPEN
          </span>
        </div>
        {Object.values(data?.systemHealth||{}).every(Boolean)&&!(data?.expiringTrials>0)
          ? <div style={{fontSize:13,color:C.green,padding:'10px 12px',background:`${C.green}0d`,borderRadius:7}}>No immediate operational or trial-conversion exceptions.</div>
          : <div style={{display:'grid',gap:7}}>
              {Object.entries(data?.systemHealth||{}).filter(([,healthy])=>!healthy).map(([service])=><div key={service} style={{fontSize:13,color:C.red}}>● {service} needs attention</div>)}
              {data?.expiringTrials>0&&<div style={{fontSize:13,color:C.orange}}>● {data.expiringTrials} trial{data.expiringTrials===1?'':'s'} expire within 48 hours</div>}
            </div>}
      </div>

      <div style={sectionLabel}>Users</div>
      <div style={grid4}>
        <MetricCard C={C} label="Total users" value={data?.totalUsers} sub="all time" />
        <MetricCard C={C} label="Active today" value={data?.activeToday} sub="signed in last 24h" />
        <MetricCard C={C} label="New this week" value={data?.newThisWeek} sub={data?.newThisWeek > 0 ? `+${data.newThisWeek} vs last week` : '0 new'} subVariant={data?.newThisWeek > 0 ? 'up' : null} />
        <MetricCard C={C} label="On free trial" value={data?.trialUsers} sub="of 7 days" />
        <MetricCard C={C} label="Paid subscribers" value={data?.paidUsers} sub="actual count — pricing is per-plan in Stripe" />
        <MetricCard C={C} label="Conversion rate" value={conv !== null ? `${conv}%` : null} sub="trial → paid" subVariant={conv > 30 ? 'up' : conv < 15 ? 'down' : null} />
      </div>

      <div style={sectionLabel}>Revenue <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— rough estimate only, see note below</span></div>
      <div style={grid4}>
        <MetricCard C={C} label="MRR (est.)" value={mrr !== null ? `~$${mrr.toLocaleString()}` : null} sub={`assumes flat $${ASSUMED_FLAT_RATE}/mo per paid user`} />
        <MetricCard C={C} label="ARR (est.)" value={mrr !== null ? `~$${(mrr * 12).toLocaleString()}` : null} sub="× 12, same assumption" />
        <MetricCard C={C} label="Trials expiring" value={data?.expiringTrials} sub="next 48 hours" subVariant={data?.expiringTrials > 0 ? 'down' : null} />
      </div>
      <div style={{ fontSize: 10.5, color: C.dim, marginTop: 6, lineHeight: 1.6, fontStyle: 'italic' }}>
        MRR/ARR assume every paid user pays a flat ${ASSUMED_FLAT_RATE}/mo — actual pricing (tiers, discounts, annual plans) lives in Stripe, not here. Treat these as directional, not actual revenue.
      </div>

      <div style={sectionLabel}>App health</div>
      <div style={grid2}>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Feature usage</div>
          <FeatureBars C={C} features={data?.features} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>System status</div>
          <SystemStatus C={C} health={data?.systemHealth} details={data?.systemHealthDetails} />
        </div>
      </div>

      <div style={sectionLabel}>Activity</div>
      <div style={grid2}>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Signup trend (last 14 days)</div>
          {chartJsReady && data?.signupsByDay ? <SignupChart C={C} data={data.signupsByDay} /> : <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 13 }}>Loading chart…</div>}
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Recent signups</div>
          <div style={{ maxHeight: 192, overflowY: 'auto' }}>
            <RecentUsers C={C} users={data?.recentUsers} />
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
