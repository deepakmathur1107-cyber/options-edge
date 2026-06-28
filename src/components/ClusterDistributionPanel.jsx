import { useState, useEffect } from 'react';

// ── Cluster Distribution panel — item 4 tuning support. Turns the manual
// SQL query (item4-cluster-tuning-check.sql) into a real admin view.
// Deliberately does NOT suggest a new threshold — surfaces the raw
// distribution; the judgment call stays human. See
// api/admin/cluster-distribution.js for the backing query.

export default function ClusterDistributionPanel({ getToken, theme }) {
  const C = theme || {};
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const token = await (getToken ? getToken() : Promise.resolve(null));
        const res = await fetch('/api/admin/cluster-distribution?days=14&minSize=3', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setData(await res.json());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken]);

  if (loading) return <div style={{ fontSize: 12, color: C.dim }}>Loading…</div>;
  if (error) return (
    <div style={{ fontSize: 12, color: C.red, background: `${C.red}12`, border: `1px solid ${C.red}30`, borderRadius: 6, padding: '10px 12px' }}>
      Error: {error}
    </div>
  );
  if (!data) return null;

  const cell = { padding: '7px 10px', fontSize: 12, color: C.text };

  return (
    <div>
      {data.lessHistoryThanRequested && (
        <div style={{ fontSize: 12, color: C.orange, background: `${C.orange}10`, border: `1px solid ${C.orange}30`, borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          Showing {data.distinctDaysFound} day(s) of signal_history (requested {data.requestedDays}) — not a full {data.requestedDays}-day picture yet. More trading days will fill this in.
        </div>
      )}
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>
        Live threshold (CLUSTER_MIN_COUNT in api/scan-cache.js): <strong style={{ color: C.text }}>{data.liveClusterMinCount}</strong>
        {' · '}showing groups of {data.minSize}+ tickers (one below the live threshold, so you can see what's just under the bar too).
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 320, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
          <thead style={{ background: C.bgAlt, borderBottom: `1px solid ${C.border}` }}>
            <tr>
              <th style={{ ...cell, textAlign: 'left', fontSize: 10.5, textTransform: 'uppercase', color: C.dim }}>Day</th>
              <th style={{ ...cell, textAlign: 'left', fontSize: 10.5, textTransform: 'uppercase', color: C.dim }}>Sector</th>
              <th style={{ ...cell, textAlign: 'left', fontSize: 10.5, textTransform: 'uppercase', color: C.dim }}>Direction</th>
              <th style={{ ...cell, textAlign: 'right', fontSize: 10.5, textTransform: 'uppercase', color: C.dim }}>Cluster size</th>
            </tr>
          </thead>
          <tbody>
            {data.clusters.length === 0 && (
              <tr><td colSpan={4} style={{ ...cell, textAlign: 'center', color: C.dim, padding: '16px 10px' }}>No clusters at or above the minimum size in this window</td></tr>
            )}
            {data.clusters.map((c, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.border}20` }}>
                <td style={{ ...cell, color: C.dim, fontSize: 11 }}>{c.day}</td>
                <td style={cell}>{c.sector}</td>
                <td style={{ ...cell, color: c.direction === 'put' ? C.red : C.green }}>{c.direction}</td>
                <td style={{
                  ...cell, textAlign: 'right', fontFamily: "'IBM Plex Mono', monospace",
                  fontWeight: c.clusterSize >= data.liveClusterMinCount ? 700 : 400,
                  color: c.clusterSize >= data.liveClusterMinCount ? C.orange : C.dim,
                }}>
                  {c.clusterSize}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
