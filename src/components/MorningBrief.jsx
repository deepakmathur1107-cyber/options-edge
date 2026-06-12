/**
 * src/components/MorningBrief.jsx
 * Displays cached morning brief from /api/brief
 * Conclusion-first layout: Bias → Risk Trigger → expandable details
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const BIAS_COLOR = { Bullish: '#00ff88', Neutral: '#ff9500', Bearish: '#ff4466' }
const BIAS_BG    = { Bullish: '#00ff8815', Neutral: '#ff950015', Bearish: '#ff446615' }
const BIAS_ICON  = { Bullish: '▲', Neutral: '◆', Bearish: '▼' }

// ── Market Calendar (NYSE holidays) ────────────────────────────────────────

function nthWeekday(year, month, dow, n) {
  const d = new Date(year, month - 1, 1); let count = 0
  while (true) { if (d.getDay() === dow) { count++; if (count === n) return new Date(d) } d.setDate(d.getDate() + 1) }
}
function lastWeekday(year, month, dow) {
  const d = new Date(year, month, 0)
  while (d.getDay() !== dow) d.setDate(d.getDate() - 1)
  return new Date(d)
}
function goodFriday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451)
  const month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1
  const easter=new Date(year,month-1,day); easter.setDate(easter.getDate()-2); return easter
}
function observed(d) {
  const day=d.getDay()
  if(day===6) return new Date(d.getFullYear(),d.getMonth(),d.getDate()-1)
  if(day===0) return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)
  return d
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function getHolidays(year) {
  return new Set([
    ymd(observed(new Date(year,0,1))),   // New Year's Day
    ymd(nthWeekday(year,1,1,3)),         // MLK Day
    ymd(nthWeekday(year,2,1,3)),         // Presidents Day
    ymd(goodFriday(year)),               // Good Friday
    ymd(lastWeekday(year,5,1)),          // Memorial Day
    ymd(observed(new Date(year,5,19))),  // Juneteenth
    ymd(observed(new Date(year,6,4))),   // Independence Day
    ymd(nthWeekday(year,9,1,1)),         // Labor Day
    ymd(nthWeekday(year,11,4,4)),        // Thanksgiving
    ymd(observed(new Date(year,11,25))), // Christmas
  ])
}

// Get date parts in a given IANA timezone using Intl (no toLocaleString→new Date() bug)
function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  })
  return Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]))
}

function isTradingDay(date) {
  const p    = tzParts(date, 'America/New_York')  // NYSE is ET, not CT
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false
  const key  = `${p.year}-${p.month}-${p.day}`
  const year = parseInt(p.year, 10)
  return !getHolidays(year).has(key)
}

// Full market status from device clock
function getMarketStatus(now = new Date()) {
  if (!isTradingDay(now)) {
    const p    = tzParts(now, 'America/Chicago')
    const key  = `${p.year}-${p.month}-${p.day}`
    const year = parseInt(p.year, 10)
    const isHoliday = getHolidays(year).has(key)
    // Find next trading day label
    const next = new Date(now)
    for (let i = 1; i <= 10; i++) {
      next.setDate(next.getDate() + 1)
      if (isTradingDay(next)) break
    }
    const nextLabel = next.toLocaleDateString('en-US', {
      timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric'
    })
    const reason = isHoliday ? 'Market holiday' : 'Weekend'
    return { open: false, reason, nextLabel }
  }

  const p    = tzParts(now, 'America/New_York')
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10)
  if (mins < 9 * 60 + 30) return { open: false, reason: 'Pre-market', nextLabel: 'today at 9:30 AM ET' }
  if (mins >= 16 * 60)    return { open: false, reason: 'After hours', nextLabel: 'tomorrow 9:30 AM ET' }
  return { open: true, reason: 'Market open', nextLabel: null }
}

// Is it a trading day and before 9:30 AM CT? (cron fires at 8 AM CT = 9 AM ET)
// Poll window covers the time before + shortly after cron fires
function isPreCronWindow(now = new Date()) {
  if (!isTradingDay(now)) return false
  const p    = tzParts(now, 'America/Chicago')
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10)
  return mins < 9 * 60 + 30
}

// Calendar date key in CT: "YYYY-MM-DD"
function datekeyCT(iso) {
  const p = tzParts(new Date(iso), 'America/Chicago')
  return `${p.year}-${p.month}-${p.day}`
}

function todayKeyCT() {
  return datekeyCT(new Date().toISOString())
}

// Format Date for display
function fmtDateTime(iso, tz = 'America/Chicago') {
  if (!iso) return '—'
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time} CT`
}

// ── Component ───────────────────────────────────────────────────────────────

export default function MorningBrief({ getToken }) {
  const [brief,       setBrief]       = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [expanded,    setExpanded]    = useState(false)
  const [generatedAt, setGeneratedAt] = useState(null)
  const [isOldBrief,  setIsOldBrief]  = useState(false)
  const [marketSt,    setMarketSt]    = useState(() => getMarketStatus())
  const pollRef = useRef(null)

  // Update market status every minute
  useEffect(() => {
    const t = setInterval(() => setMarketSt(getMarketStatus()), 60 * 1000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch('/api/brief', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 404) { setError('notGenerated'); setLoading(false); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setBrief(data.brief)
      setGeneratedAt(data.generatedAt)
      const isOld = data.generatedAt ? datekeyCT(data.generatedAt) !== todayKeyCT() : false
      setIsOldBrief(isOld)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  // Initial load
  useEffect(() => { load() }, [load])

  // If brief is from yesterday and we're pre-9:30am CT, poll every 5 min for cron
  useEffect(() => {
    if (!isOldBrief || !isPreCronWindow()) return
    pollRef.current = setInterval(() => {
      if (!isPreCronWindow()) { clearInterval(pollRef.current); return }
      load()
    }, 5 * 60 * 1000)
    return () => clearInterval(pollRef.current)
  }, [isOldBrief, load])

  const biasColor = brief ? (BIAS_COLOR[brief.bias] || '#c8d8e8') : '#c8d8e8'
  const biasBg    = brief ? (BIAS_BG[brief.bias]    || '#c8d8e820') : '#c8d8e820'
  const biasIcon  = brief ? (BIAS_ICON[brief.bias]  || '◆') : '◆'

  // Header right side: show brief date if old, else time
  const headerRight = generatedAt
    ? isOldBrief
      ? new Date(generatedAt).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' })
      : new Date(generatedAt).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' }) + ' CT'
    : ''

  // Footer: brief provenance + live market status
  const briefLabel = generatedAt
    ? `Brief for ${new Date(generatedAt).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' })} · Generated ${new Date(generatedAt).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`
    : ''
  const statusLabel = marketSt.open
    ? '🟢 Market open'
    : marketSt.reason === 'Market holiday'
      ? `🔴 ${marketSt.reason} · Reopens ${marketSt.nextLabel}`
      : marketSt.reason === 'Weekend'
        ? `⚪ ${marketSt.reason} · Reopens ${marketSt.nextLabel}`
        : `⚫ ${marketSt.reason}${marketSt.nextLabel ? ' · ' + marketSt.nextLabel : ''}`

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
      <div style={S.header}>
        <span style={S.headerLabel}>📊 MORNING READOUT</span>
        <span style={S.statusPill(marketSt.open)}>{statusLabel}</span>
      </div>
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🕐</div>
        <div style={{ fontSize: 12, color: '#c8d8e8' }}>Today's brief generates at 8 AM CT</div>
        <div style={{ fontSize: 10, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', marginTop: 4 }}>Use GENERATE to create one now</div>
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
          <span style={S.time}>{headerRight}</span>
        </div>
      </div>

      {/* Old brief warning */}
      {isOldBrief && (
        <div style={S.oldWarning}>
          ⚠ Showing {fmtDateTime(generatedAt)} brief — today's hasn't generated yet
          {isPreCronWindow() && <span style={{ color: '#4a7a8a' }}> · checking every 5 min</span>}
        </div>
      )}

      {/* Bias */}
      <div style={{ ...S.biasBlock, background: biasBg, borderColor: biasColor }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 16, color: biasColor, fontWeight: 900 }}>{biasIcon}</span>
          <span style={{ fontSize: 18, fontWeight: 900, color: biasColor, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: 2 }}>{brief.bias?.toUpperCase()}</span>
          <span style={{ fontSize: 10, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', marginLeft: 'auto', textAlign: 'right' }}>{brief.tone}</span>
        </div>
        <div style={{ fontSize: 12, color: '#c8d8e8', lineHeight: 1.5 }}>{brief.why}</div>
      </div>

      {/* Risk trigger */}
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

      {/* Footer: brief date + live market status */}
      <div style={S.footer}>
        <span>{briefLabel}</span>
        <span style={{ margin: '0 8px', color: '#1a3a4a' }}>·</span>
        <span style={{ color: marketSt.open ? '#00ff8880' : '#4a7a8a' }}>{statusLabel}</span>
      </div>
    </div>
  )
}

const S = {
  card:        { background: '#0d1a26', border: '1px solid #1a2e3e', borderRadius: 8, overflow: 'hidden', fontFamily: 'Inter, sans-serif' },
  header:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #1a2e3e', background: '#0a1520' },
  headerLabel: { fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#c8d8e8', fontFamily: 'IBM Plex Mono, monospace' },
  time:        { fontSize: 10, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace' },
  oldBadge:    { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: '#ff9500', background: '#ff950020', border: '1px solid #ff950040', borderRadius: 3, padding: '2px 6px', fontFamily: 'IBM Plex Mono, monospace' },
  oldWarning:  { fontSize: 10, color: '#ff9500', background: '#ff950010', borderBottom: '1px solid #ff950025', padding: '7px 16px', fontFamily: 'IBM Plex Mono, monospace' },
  biasBlock:   { margin: '12px 16px 0', borderRadius: 6, border: '1px solid', padding: '12px 14px' },
  riskBlock:   { margin: '10px 16px 0', padding: '10px 14px', background: '#ff446610', border: '1px solid #ff446630', borderRadius: 6, display: 'flex', alignItems: 'flex-start' },
  expandBtn:   { width: '100%', background: 'transparent', border: 'none', borderTop: '1px solid #1a2e3e', color: '#4a7a8a', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, fontFamily: 'IBM Plex Mono, monospace', padding: '10px', cursor: 'pointer', marginTop: 12 },
  sectionTitle:{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', marginBottom: 8 },
  bullet:      { display: 'flex', gap: 8, fontSize: 11, color: '#c8d8e8', lineHeight: 1.6, marginBottom: 4 },
  footer:      { fontSize: 9, color: '#2a4a5a', fontFamily: 'IBM Plex Mono, monospace', padding: '8px 16px', borderTop: '1px solid #1a2e3e', textAlign: 'center', marginTop: 12, display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', gap: 2 },
  statusPill:  (open) => ({ fontSize: 9, color: open ? '#00ff88' : '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace' }),
}
