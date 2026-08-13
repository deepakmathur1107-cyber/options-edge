import { useEffect, useState } from 'react'

export default function ClusterDistributionPanel({ getToken, theme: C = {} }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState(null)
  const [days, setDays] = useState(14)

  const load = async () => {
    setLoading(true); setError('')
    try {
      const token = await (getToken ? getToken() : Promise.resolve(null))
      const response = await fetch(`/api/admin/cluster-distribution?days=${days}&minSize=3`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      setData(await response.json())
      setLastFetchedAt(new Date())
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [getToken, days])

  if (loading && !data) return <div style={{ fontSize: 12, color: C.dim }}>Loading…</div>
  if (error && !data) return <div style={{ fontSize: 12, color: C.red, background: `${C.red}12`, border: `1px solid ${C.red}30`, borderRadius: 6, padding: '10px 12px' }}>Error: {error}<button onClick={load} style={{ marginLeft: 10, fontSize: 11, cursor: 'pointer' }}>Retry</button></div>
  if (!data) return null

  const cell = { padding: '8px 10px', fontSize: 12, color: C.text }
  const heading = { ...cell, textAlign: 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: C.dim }

  return (
    <div>
      {data.lessHistoryThanRequested && <div style={{ fontSize: 12, color: C.orange, background: `${C.orange}10`, border: `1px solid ${C.orange}30`, borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>Only {data.distinctDaysFound} day(s) of history were found in the requested {data.requestedDays}-day window.</div>}
      {data.truncated && <div style={{ fontSize: 12, color: C.red, background: `${C.red}10`, border: `1px solid ${C.red}30`, borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>This window exceeded the 50,000-row safety limit. Select a shorter period before changing the threshold.</div>}
      {error && <div style={{ fontSize: 11, color: C.red, marginBottom: 8 }}>Refresh failed: {error}. Showing the previous result.</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: C.dim }}>Live threshold: <strong style={{ color: C.text }}>{data.liveClusterMinCount}</strong> · showing same-run groups of {data.minSize}+ distinct tickers</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {[7, 14, 30].map(value => <button key={value} onClick={() => setDays(value)} disabled={loading} style={{ fontSize: 10, cursor: 'pointer', padding: '4px 7px', borderRadius: 4, border: `1px solid ${days === value ? C.orange : C.border}`, background: days === value ? `${C.orange}14` : 'transparent', color: days === value ? C.orange : C.dim }}>{value}d</button>)}
          <button onClick={load} disabled={loading} style={{ fontSize: 11, cursor: loading ? 'wait' : 'pointer', padding: '4px 9px', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bgAlt, color: C.text, opacity: loading ? .6 : 1 }}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
      </div>

      <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.5, marginBottom: 10 }}>
        {data.runsAnalyzed} scanner runs reconstructed from {data.rowsAnalyzed?.toLocaleString()} observations. Historical runs are separated by timeframe and a 7-minute observation gap. {lastFetchedAt && `Updated ${lastFetchedAt.toLocaleTimeString()}.`}
      </div>

      <div style={{ overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 340 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead style={{ background: C.bgAlt, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0 }}><tr><th style={heading}>Run</th><th style={heading}>Timeframe</th><th style={heading}>Sector</th><th style={heading}>Direction</th><th style={{ ...heading, textAlign: 'right' }}>Size</th></tr></thead>
          <tbody>
            {data.clusters.length === 0 && <tr><td colSpan={5} style={{ ...cell, color: C.dim, textAlign: 'center', padding: 18 }}>No reconstructed run contained a cluster at or above this size.</td></tr>}
            {data.clusters.map((cluster, index) => {
              const meetsLiveThreshold = cluster.clusterSize >= data.liveClusterMinCount
              return <tr key={`${cluster.runAt}-${cluster.timeframe}-${cluster.sector}-${cluster.direction}-${index}`} style={{ borderBottom: `1px solid ${C.border}20` }}>
                <td style={{ ...cell, color: C.dim, fontSize: 11, whiteSpace: 'nowrap' }}>{new Date(cluster.runAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                <td style={{ ...cell, color: C.dim, fontSize: 11 }}>{cluster.timeframe}</td>
                <td style={cell}>{cluster.sector}</td>
                <td style={{ ...cell, color: cluster.direction === 'put' ? C.red : C.green, textTransform: 'capitalize' }}>{cluster.direction}</td>
                <td style={{ ...cell, textAlign: 'right', fontFamily: "'IBM Plex Mono', monospace", fontWeight: meetsLiveThreshold ? 700 : 400, color: meetsLiveThreshold ? C.orange : C.dim }}>{cluster.clusterSize}</td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 9, fontSize: 10.5, color: C.dim }}>Size 3 is just below the live threshold. Orange sizes meet or exceed it. Look for repeated sector/direction concentration across multiple runs before tuning.</div>
    </div>
  )
}
