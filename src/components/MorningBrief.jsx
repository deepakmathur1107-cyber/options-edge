/**
 * src/components/MorningBrief.jsx
 * Displays cached morning brief from /api/brief
 * Conclusion-first layout: Bias → Risk Trigger → expandable details
 *
 * Refresh logic:
 * - Loads once on mount. Server handles generation if today's brief is missing.
 * - If it's pre-7am CST on a weekday and brief is from yesterday, polls every
 *   5 min until 7:30am waiting for cron to fire. No other auto-refresh needed.
 */
import { useState, useEffect, useRef } from 'react'

const BIAS_COLOR = { Bullish: '#00ff88', Neutral: '#ff9500', Bearish: '#ff4466' }
const BIAS_BG    = { Bullish: '#00ff8815', Neutral: '#ff950015', Bearish: '#ff446615' }
const BIAS_ICON  = { Bullish: '▲', Neutral: '◆', Bearish: '▼' }

// Get current date string in CT (YYYY-MM-DD) for same-day comparison
function todayCT() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  })
}

// True if it's a weekday and before 7:30am CT — waiting for cron to fire
function isPreCronWindow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]))
  if (parts.weekday === 'Sun' || parts.weekday === 'Sat') return false
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10)
  return mins < 7 * 60 + 30  // before 7:30am CT
}

// Format a Date as "Thu, Jun 12 · 8:03 AM CT"
function fmtBriefDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago'
  })
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
  })
  return `${date} · ${time} CT`
}

export default function MorningBrief({ getToken }) {
  const [brief,       setBrief]       = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [expanded,    setExpanded]    = useState(false)
  const [generatedAt, setGeneratedAt] = useState(null)
  const [isOldBrief,  setIsOldBrief]  = useState(false)  // brief is from a previous trading day
  const pollRef = useRef(null)

  async function load() {
    try {
      const token = await getToken()
      const res = await fetch('/api/brief', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 404) { setError('notGenerated'); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setBrief(data.brief)
      setGeneratedAt(data.generatedAt)
      // isOldBrief = brief was generated on a previous calendar day (CT)
      const briefDay = data.generatedAt
        ? new Date(data.generatedAt).toLocaleDateString('en-US', {
            timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
          })
        : null
      setIsOldBrief(briefDay ? briefDay !== todayCT() : false)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Initial load
  useEffect(() => { load() }, [getToken])  // eslint-disable-line react-hooks/exhaustive-deps

  // If brief is from yesterday and we're in the pre-cron window (before 7:30am CT),
  // poll every 5 min waiting for today's cron to fire
  useEffect(() => {
    if (!isOldBrief || !isPreCronWindow()) return

    pollRef.current = setInterval(() => {
      if (!isPreCronWindow()) {
        clearInterval(pollRef.current)
        return
      }
      load()
    }, 5 * 60 * 1000)

    return () => clearInterval(pollRef.current)
  }, [isOldBrief])  // eslint-disable-line react-hooks/exhaustive-deps

  const biasColor = brief ? (BIAS_COLOR[brief.bias] || '#c8d8e8') : '#c8d8e8'
  const biasBg    = brief ? (BIAS_BG[brief.bias]    || '#c8d8e820') : '#c8d8e820'
  const biasIcon  = brief ? (BIAS_ICON[brief.bias]  || '◆') : '◆'

  // Header timestamp — show date only if it's an old brief
  const headerTime = generatedAt
    ? isOldBrief
      ? new Date(generatedAt).toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago'
        })
      : new Date(generatedAt).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago'
        }) + ' CT'
    : ''

  if (loading) return (
    <div style={S.card}>
      <div style={S.header}><span style={S.headerLabel}>📊 MORNING READOUT</span></div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[100, 60, 80].map((w, i) => (
          <div key={i} style={{ height: 10, width: `${w}%`, background: '#1a2e3e', borderRadius: 4 }} />
        ))}
      </div>
    </div>
  )

  if (error === 'notGenerated') return (
    <div style={S.card}>
      <div style={S.header}><span style={S.headerLabel}>📊 MORNING READOUT</span></div>
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🕐</div>
        <div style={{ fontSize: 12, color: '#c8d8e8' }}>Today's brief generates at 7 AM CT</div>
        <div style={{ fontSize: 10, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', marginTop: 4 }}>
          Use GENERATE to create one now
        </div>
      </div>
    </div>
  )

  if (error || !brief) return (
    <div style={S.card}>
      <div style={S.header}><span style={S.headerLabel}>📊 MORNING READOUT</span></div>
      <div style={{ padding: 16, color: '#ff4466', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}>⚠ {error || 'Failed to load'}</div>
    </div>
  )

  return (
    <div style={S.card}>
      {/* Header */}
      <div style={S.header}>
        <span style={S.headerLabel}>📊 MORNING READOUT</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isOldBrief && <span style={S.oldBadge}>PREV DAY</span>}
          <span style={S.time}>{headerTime}</span>
        </div>
      </div>

      {/* Old brief warning bar */}
      {isOldBrief && (
        <div style={S.oldWarning}>
          ⚠ This is {fmtBriefDate(generatedAt)} brief — today's hasn't generated yet
          {isPreCronWindow() && <span style={{ color: '#4a7a8a' }}> · checking every 5 min</span>}
        </div>
      )}

      {/* Bias — conclusion first */}
      <div style={{ ...S.biasBlock, background: biasBg, borderColor: biasColor }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 16, color: biasColor, fontWeight: 900 }}>{biasIcon}</span>
          <span style={{ fontSize: 18, fontWeight: 900, color: biasColor, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: 2 }}>{brief.bias?.toUpperCase()}</span>
          <span style={{ fontSize: 10, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', marginLeft: 'auto', textAlign: 'right' }}>{brief.tone}</span>
        </div>
        <div style={{ fontSize: 12, color: '#c8d8e8', lineHeight: 1.5 }}>{brief.why}</div>
      </div>

      {/* Risk trigger — always visible */}
      <div style={S.riskBlock}>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#ff6688', fontFamily: 'IBM Plex Mono, monospace', flexShrink: 0, paddingTop: 1 }}>⚡ RISK TRIGGER</span>
        <span style={{ fontSize: 11, color: '#c8d8e8', lineHeight: 1.5, marginLeft: 8 }}>{brief.risk_trigger}</span>
      </div>

      {/* Expand toggle */}
      <button onClick={() => setExpanded(e => !e)} style={S.expandBtn}>
        {expanded ? '▲ HIDE DETAILS' : '▼ SHOW DETAILS'}
      </button>

      {/* Expandable details */}
      {expanded && (
        <div style={{ padding: '0 16px 4px', borderTop: '1px solid #1a2e3e' }}>
          <div style={{ paddingTop: 12, paddingBottom: 4 }}>
            <div style={S.sectionTitle}>📅 TODAY'S EVENTS</div>
            {(brief.events || []).map((ev, i) => (
              <div key={i} style={S.bullet}><span style={{ color: '#00ff88', fontWeight: 700, flexShrink: 0 }}>•</span><span>{ev}</span></div>
            ))}
          </div>
          <div style={{ paddingTop: 8, paddingBottom: 4 }}>
            <div style={S.sectionTitle}>📍 KEY LEVELS</div>
            {(brief.levels || []).map((lv, i) => (
              <div key={i} style={S.bullet}><span style={{ color: '#00c8ff', fontWeight: 700, flexShrink: 0 }}>→</span><span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>{lv}</span></div>
            ))}
          </div>
        </div>
      )}

      <div style={S.footer}>
        {`Not financial advice · Brief for ${
          generatedAt
            ? new Date(generatedAt).toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago'
              })
            : '—'
        } · Generated ${
          generatedAt
            ? new Date(generatedAt).toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
              }) + ' CT'
            : '—'
        }`}
      </div>
    </div>
  )
}

const S = {
  card:       { background: '#0d1a26', border: '1px solid #1a2e3e', borderRadius: 8, overflow: 'hidden', fontFamily: 'Inter, sans-serif' },
  header:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #1a2e3e', background: '#0a1520' },
  headerLabel:{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#c8d8e8', fontFamily: 'IBM Plex Mono, monospace' },
  time:       { fontSize: 10, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace' },
  oldBadge:   { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: '#ff9500', background: '#ff950020', border: '1px solid #ff950040', borderRadius: 3, padding: '2px 6px', fontFamily: 'IBM Plex Mono, monospace' },
  oldWarning: { fontSize: 10, color: '#ff9500', background: '#ff950010', borderBottom: '1px solid #ff950025', padding: '7px 16px', fontFamily: 'IBM Plex Mono, monospace' },
  biasBlock:  { margin: '12px 16px 0', borderRadius: 6, border: '1px solid', padding: '12px 14px' },
  riskBlock:  { margin: '10px 16px 0', padding: '10px 14px', background: '#ff446610', border: '1px solid #ff446630', borderRadius: 6, display: 'flex', alignItems: 'flex-start' },
  expandBtn:  { width: '100%', background: 'transparent', border: 'none', borderTop: '1px solid #1a2e3e', color: '#4a7a8a', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, fontFamily: 'IBM Plex Mono, monospace', padding: '10px', cursor: 'pointer', marginTop: 12 },
  sectionTitle:{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', marginBottom: 8 },
  bullet:     { display: 'flex', gap: 8, fontSize: 11, color: '#c8d8e8', lineHeight: 1.6, marginBottom: 4 },
  footer:     { fontSize: 9, color: '#2a4a5a', fontFamily: 'IBM Plex Mono, monospace', padding: '8px 16px', borderTop: '1px solid #1a2e3e', textAlign: 'center', marginTop: 12 },
}
