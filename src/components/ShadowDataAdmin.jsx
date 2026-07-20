import { useState, useEffect, useCallback } from 'react';

// src/components/ShadowDataAdmin.jsx
// Added 2026-07-21. Read-only visibility into everything built as "shadow"
// this week — never had any UI before this. Standalone component,
// deliberately NOT merged into AdminDashboard.jsx's existing 332 lines, to
// avoid touching a file with logic I haven't fully audited. Same
// auth/fetch pattern as AdminDashboard's loadMetrics (getToken prop,
// Bearer header, /api/admin/* endpoint) — see that component for the
// pattern this mirrors.
//
// Props: getToken (Clerk token getter, same as AdminDashboard), theme (the
// `C` color-token object already used throughout the app).

const TZ_ABBREV = { 'America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Los_Angeles':'PT' };
function fmtLocalTime(date) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${timeStr} ${TZ_ABBREV[tz] || tz}`;
}

function SectionCard({ title, caveat, C, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '16px 20px', marginBottom: 16, boxShadow: C.shadow }}>
      <div style={{ fontSize: 12, color: C.dim, letterSpacing: 1, fontWeight: 700, fontFamily: "'Inter',sans-serif", textTransform: 'uppercase', marginBottom: caveat ? 4 : 12 }}>{title}</div>
      {caveat && <div style={{ fontSize: 11, color: C.subtext, marginBottom: 12, lineHeight: 1.4 }}>{caveat}</div>}
      {children}
    </div>
  );
}

export default function ShadowDataAdmin({ getToken, theme: C }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const resolvedGetToken = getToken || (async () => null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await resolvedGetToken();
      const res = await fetch('/api/admin/shadow-data', {
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

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <div style={{ padding: 20, color: C.dim, fontSize: 13 }}>Loading shadow data…</div>;
  if (error) return (
    <div style={{ padding: 20, color: C.red, fontSize: 13 }}>
      Failed to load: {error}
      <button onClick={load} style={{ marginLeft: 12, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 10px', color: C.text, cursor: 'pointer' }}>Retry</button>
    </div>
  );
  if (!data) return null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: C.text, fontFamily: "'Fraunces',serif" }}>Shadow data (internal)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastUpdated && <span style={{ fontSize: 11, color: C.dim }}>Updated {lastUpdated}</span>}
          <button onClick={load} disabled={loading} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 10px', fontSize: 12, color: C.text, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <SectionCard title="Live vertical spread coverage (Phase 1)" C={C}>
        <div style={{ fontSize: 24, fontFamily: "'IBM Plex Mono',monospace", color: C.text, marginBottom: 12 }}>
          {data.liveSpread.totalWithSpread.toLocaleString()} <span style={{ fontSize: 13, color: C.dim }}>rows with a computed spread</span>
        </div>
        {data.liveSpread.recent.length > 0 && (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                <th style={{ padding: '4px 8px' }}>Ticker</th><th style={{ padding: '4px 8px' }}>Timeframe</th><th style={{ padding: '4px 8px' }}>Side</th>
                <th style={{ padding: '4px 8px' }}>Debit</th><th style={{ padding: '4px 8px' }}>Max profit</th><th style={{ padding: '4px 8px' }}>Breakeven req.</th>
              </tr>
            </thead>
            <tbody>
              {data.liveSpread.recent.map((r, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '4px 8px', color: C.text }}>{r.ticker}</td>
                  <td style={{ padding: '4px 8px', color: C.subtext }}>{r.timeframe}</td>
                  <td style={{ padding: '4px 8px', color: C.subtext }}>{r.option_type}</td>
                  <td style={{ padding: '4px 8px', color: C.text, fontFamily: "'IBM Plex Mono',monospace" }}>${r.shadow_vertical_spread.net_debit}</td>
                  <td style={{ padding: '4px 8px', color: C.text, fontFamily: "'IBM Plex Mono',monospace" }}>${r.shadow_vertical_spread.max_profit}</td>
                  <td style={{ padding: '4px 8px', color: C.text, fontFamily: "'IBM Plex Mono',monospace" }}>{r.shadow_vertical_spread.breakeven_req_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Technical reweight deltas (Phase 2, piece 1)" caveat="Delta = shadow score minus live score. Live score is what's actually shown to users — this is only the parallel experiment." C={C}>
        {data.technicalReweight.recent.length > 0 ? (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                <th style={{ padding: '4px 8px' }}>Ticker</th><th style={{ padding: '4px 8px' }}>Timeframe</th>
                <th style={{ padding: '4px 8px' }}>Live score</th><th style={{ padding: '4px 8px' }}>Shadow score</th><th style={{ padding: '4px 8px' }}>Delta</th>
              </tr>
            </thead>
            <tbody>
              {data.technicalReweight.recent.map((r, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '4px 8px', color: C.text }}>{r.ticker}</td>
                  <td style={{ padding: '4px 8px', color: C.subtext }}>{r.timeframe}</td>
                  <td style={{ padding: '4px 8px', color: C.text, fontFamily: "'IBM Plex Mono',monospace" }}>{r.score}</td>
                  <td style={{ padding: '4px 8px', color: C.text, fontFamily: "'IBM Plex Mono',monospace" }}>{r.shadow_technical_reweight_score}</td>
                  <td style={{ padding: '4px 8px', fontFamily: "'IBM Plex Mono',monospace", color: r.delta > 0 ? C.green : r.delta < 0 ? C.red : C.dim }}>{r.delta > 0 ? '+' : ''}{r.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div style={{ fontSize: 12, color: C.subtext }}>No data yet.</div>}
      </SectionCard>

      <SectionCard title="News signal coverage (Phase 2, piece 2, Quick only)" C={C}>
        <div style={{ fontSize: 24, fontFamily: "'IBM Plex Mono',monospace", color: C.text }}>
          {data.newsSignal.totalWithData.toLocaleString()} <span style={{ fontSize: 13, color: C.dim }}>Quick rows with news data</span>
        </div>
      </SectionCard>

      <SectionCard title="Historical spread backfill — preliminary early read" caveat={data.historicalBackfill.caveat} C={C}>
        <div style={{ fontSize: 12, color: C.subtext, marginBottom: 10 }}>{data.historicalBackfill.resolvedCount.toLocaleString()} rows backfilled so far</div>
        {data.historicalBackfill.summary.length > 0 && (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                <th style={{ padding: '4px 8px' }}>Side</th><th style={{ padding: '4px 8px' }}>n (known)</th>
                <th style={{ padding: '4px 8px' }}>Avg P&amp;L</th><th style={{ padding: '4px 8px' }}>Full win</th><th style={{ padding: '4px 8px' }}>Partial</th><th style={{ padding: '4px 8px' }}>Total loss</th>
              </tr>
            </thead>
            <tbody>
              {data.historicalBackfill.summary.map((s, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '4px 8px', color: C.text }}>{s.optType}</td>
                  <td style={{ padding: '4px 8px', color: C.subtext }}>{s.knownN} / {s.n}</td>
                  <td style={{ padding: '4px 8px', fontFamily: "'IBM Plex Mono',monospace", color: s.avgPnlPct > 0 ? C.green : s.avgPnlPct < 0 ? C.red : C.dim }}>{s.avgPnlPct != null ? `${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct}%` : '—'}</td>
                  <td style={{ padding: '4px 8px', color: C.text }}>{s.fullWin}</td>
                  <td style={{ padding: '4px 8px', color: C.text }}>{s.partial}</td>
                  <td style={{ padding: '4px 8px', color: C.text }}>{s.totalLoss}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
