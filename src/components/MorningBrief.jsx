/**
 * src/components/MorningBrief.jsx
 *
 * Displays the cached morning brief fetched from /api/brief.
 * Format: Tone → Why → Events → Levels → Bias → Risk Trigger
 * Mobile-first: conclusion (bias) shown first, details expandable.
 */

import { useState, useEffect } from 'react'

const BIAS_COLOR = {
  Bullish: '#00ff88',
  Neutral: '#ff9500',
  Bearish: '#ff4466',
}

const BIAS_BG = {
  Bullish: '#00ff8815',
  Neutral: '#ff950015',
  Bearish: '#ff446615',
}

const BIAS_ICON = {
  Bullish: '▲',
  Neutral: '◆',
  Bearish: '▼',
}

export default function MorningBrief({ getToken }) {
  const [brief,       setBrief]       = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [expanded,    setExpanded]    = useState(false)
  const [generatedAt, setGeneratedAt] = useState(null)
  const [isStale,     setIsStale]     = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch('/api/brief', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (res.status === 404) {
          setError('notGenerated')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setBrief(data.brief)
        setGeneratedAt(data.generatedAt)
        setIsStale(data.isStale)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [getToken])

  const biasColor = brief ? (BIAS_COLOR[brief.bias] || '#c8d8e8') : '#c8d8e8'
  const biasBg    = brief ? (BIAS_BG[brief.bias]    || '#c8d8e820') : '#c8d8e820'
  const biasIcon  = brief ? (BIAS_ICON[brief.bias]  || '◆') : '◆'

  const timeStr = generatedAt
    ? new Date(generatedAt).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York'
      }) + ' ET'
    : ''

  // ── Loading ──
  if (loading) {
    return (
      <div style={S.card}>
        <div style={S.header}>
          <span style={S.headerLabel}>📊 MORNING READOUT</span>
        </div>
        <div style={S.loadingRow}>
          <div style={S.pulse} />
          <div style={{ ...S.pulse, width: '60%' }} />
          <div style={{ ...S.pulse, width: '80%' }} />
        </div>
      </div>
    )
  }

  // ── Not generated yet ──
  if (error === 'notGenerated') {
    return (
      <div style={S.card}>
        <div style={S.header}>
          <span style={S.headerLabel}>📊 MORNING READOUT</span>
        </div>
        <div style={S.emptyState}>
          <div style={S.emptyIcon}>🕐</div>
          <div style={S.emptyText}>Brief generates at market open (9 AM ET)</div>
          <div style={S.emptySub}>Refreshes every hour on trading days</div>
        </div>
      </div>
    )
  }

  // ── Error ──
  if (error || !brief) {
    return (
      <div style={S.card}>
        <div style={S.header}>
          <span style={S.headerLabel}>📊 MORNING READOUT</span>
        </div>
        <div style={{ padding: '16px', color: '#ff4466', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}>
          ⚠ {error || 'Failed to load brief'}
        </div>
      </div>
    )
  }

  // ── Main render ──
  return (
    <div style={S.card}>
      {/* Header */}
      <div style={S.header}>
        <span style={S.headerLabel}>📊 MORNING READOUT</span>
        <div style={S.headerRight}>
          {isStale && <span style={S.staleBadge}>STALE</span>}
          <span style={S.time}>{timeStr}</span>
        </div>
      </div>

      {/* ── BIAS — shown first on mobile (conclusion up top) ── */}
      <div style={{ ...S.biasBlock, background: biasBg, borderColor: biasColor }}>
        <div style={S.biasRow}>
          <span style={{ ...S.biasIcon, color: biasColor }}>{biasIcon}</span>
          <span style={{ ...S.biasLabel, color: biasColor }}>{brief.bias?.toUpperCase()}</span>
          <span style={S.toneText}>{brief.tone}</span>
        </div>
        <div style={S.whyText}>{brief.why}</div>
      </div>

      {/* ── Risk trigger — always visible ── */}
      <div style={S.riskBlock}>
        <span style={S.riskLabel}>⚡ RISK TRIGGER</span>
        <span style={S.riskText}>{brief.risk_trigger}</span>
      </div>

      {/* ── Expand/collapse for detail ── */}
      <button onClick={() => setExpanded(e => !e)} style={S.expandBtn}>
        {expanded ? '▲ HIDE DETAILS' : '▼ SHOW DETAILS'}
      </button>

      {expanded && (
        <div style={S.details}>
          {/* Today's Events */}
          <div style={S.section}>
            <div style={S.sectionTitle}>📅 TODAY'S EVENTS</div>
            {(brief.events || []).map((ev, i) => (
              <div key={i} style={S.bullet}>
                <span style={S.dot}>•</span>
                <span>{ev}</span>
              </div>
            ))}
          </div>

          {/* Key Levels */}
          <div style={S.section}>
            <div style={S.sectionTitle}>📍 KEY LEVELS</div>
            {(brief.levels || []).map((lv, i) => (
              <div key={i} style={S.bullet}>
                <span style={{ ...S.dot, color: '#00c8ff' }}>→</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>{lv}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={S.footer}>
        AI-generated · Not financial advice · Refreshes hourly
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────
const S = {
  card: {
    background: '#0d1a26',
    border: '1px solid #1a2e3e',
    borderRadius: 8,
    overflow: 'hidden',
    fontFamily: 'Inter, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #1a2e3e',
    background: '#0a1520',
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.5,
    color: '#c8d8e8',
    fontFamily: 'IBM Plex Mono, monospace',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  time: {
    fontSize: 10,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
  },
  staleBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    color: '#ff9500',
    background: '#ff950020',
    border: '1px solid #ff950040',
    borderRadius: 3,
    padding: '2px 6px',
    fontFamily: 'IBM Plex Mono, monospace',
  },
  biasBlock: {
    margin: '12px 16px 0',
    borderRadius: 6,
    border: '1px solid',
    padding: '12px 14px',
  },
  biasRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  biasIcon: {
    fontSize: 16,
    fontWeight: 900,
    lineHeight: 1,
  },
  biasLabel: {
    fontSize: 18,
    fontWeight: 900,
    fontFamily: 'Bebas Neue, sans-serif',
    letterSpacing: 2,
  },
  toneText: {
    fontSize: 10,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
    marginLeft: 'auto',
    textAlign: 'right',
  },
  whyText: {
    fontSize: 12,
    color: '#c8d8e8',
    lineHeight: 1.5,
  },
  riskBlock: {
    margin: '10px 16px 0',
    padding: '10px 14px',
    background: '#ff446610',
    border: '1px solid #ff446630',
    borderRadius: 6,
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
  },
  riskLabel: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    color: '#ff6688',
    fontFamily: 'IBM Plex Mono, monospace',
    flexShrink: 0,
    paddingTop: 1,
  },
  riskText: {
    fontSize: 11,
    color: '#c8d8e8',
    lineHeight: 1.5,
  },
  expandBtn: {
    width: '100%',
    background: 'transparent',
    border: 'none',
    borderTop: '1px solid #1a2e3e',
    color: '#4a7a8a',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.5,
    fontFamily: 'IBM Plex Mono, monospace',
    padding: '10px',
    cursor: 'pointer',
    marginTop: 12,
  },
  details: {
    padding: '0 16px 4px',
    borderTop: '1px solid #1a2e3e',
  },
  section: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.5,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
    marginBottom: 8,
  },
  bullet: {
    display: 'flex',
    gap: 8,
    fontSize: 11,
    color: '#c8d8e8',
    lineHeight: 1.6,
    marginBottom: 4,
  },
  dot: {
    color: '#00ff88',
    flexShrink: 0,
    fontWeight: 700,
  },
  footer: {
    fontSize: 9,
    color: '#2a4a5a',
    fontFamily: 'IBM Plex Mono, monospace',
    padding: '8px 16px',
    borderTop: '1px solid #1a2e3e',
    textAlign: 'center',
  },
  loadingRow: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  pulse: {
    height: 10,
    width: '100%',
    background: '#1a2e3e',
    borderRadius: 4,
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  emptyState: {
    padding: '24px 16px',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: 28,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 12,
    color: '#c8d8e8',
    marginBottom: 4,
  },
  emptySub: {
    fontSize: 10,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
  },
}
