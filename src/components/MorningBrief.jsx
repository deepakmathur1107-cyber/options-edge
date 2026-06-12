/**
 * src/components/MorningBrief.jsx
 * "Market Readout" — system-controlled brief, refreshes every 2hrs during market hours
 * All users see the same Supabase-cached brief. No user refresh control.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

// Bias colors are always accent colors regardless of theme
const BIAS_COLOR = { Bullish: '#00c85a', Neutral: '#ff9500', Bearish: '#ff4466' }
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
    ymd(observed(new Date(year,0,1))),   ymd(nthWeekday(year,1,1,3)),
    ymd(nthWeekday(year,2,1,3)),         ymd(goodFriday(year)),
    ymd(lastWeekday(year,5,1)),          ymd(observed(new Date(year,5,19))),
    ymd(observed(new Date(year,6,4))),   ymd(nthWeekday(year,9,1,1)),
    ymd(nthWeekday(year,11,4,4)),        ymd(observed(new Date(year,11,25))),
  ])
}
function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'numeric', minute:'numeric', weekday:'short', hour12: false,
  })
  return Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]))
}
function isTradingDay(date) {
  const p = tzParts(date, 'America/New_York')
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false
  return !getHolidays(parseInt(p.year, 10)).has(`${p.year}-${p.month}-${p.day}`)
}
function getMarketStatus(now = new Date()) {
  if (!isTradingDay(now)) {
    const p = tzParts(now, 'America/Chicago')
    const isHoliday = getHolidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)
    const next = new Date(now)
    for (let i = 1; i <= 10; i++) { next.setDate(next.getDate()+1); if (isTradingDay(next)) break }
    const nextLabel = next.toLocaleDateString('en-US', { timeZone:'America/Chicago', weekday:'short', month:'short', day:'numeric' })
    return { open: false, reason: isHoliday ? 'Market holiday' : 'Weekend', nextLabel }
  }
  const p    = tzParts(now, 'America/New_York')
  const mins = parseInt(p.hour,10)*60 + parseInt(p.minute,10)
  if (mins < 9*60+30)  return { open: false, reason: 'Pre-market',  nextLabel: 'today at 9:30 AM ET' }
  if (mins >= 16*60)   return { open: false, reason: 'After hours', nextLabel: 'tomorrow 9:30 AM ET' }
  return { open: true, reason: 'Market open', nextLabel: null }
}
function sameCalendarDay(isoA, isoB) {
  const fmt = d => new Intl.DateTimeFormat('en-US', { timeZone:'America/Chicago', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(d))
  return fmt(isoA) === fmt(isoB)
}

// ── Component ───────────────────────────────────────────────────────────────

export default function MorningBrief({ getToken, theme }) {
  const C = theme || {}  // fallback to empty obj; all accesses below have safe defaults

  const [brief,         setBrief]         = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [expanded,      setExpanded]      = useState(false)
  const [generatedAt,   setGeneratedAt]   = useState(null)
  const [isOldBrief,    setIsOldBrief]    = useState(false)
  const [justRefreshed, setJustRefreshed] = useState(false)  // flash indicator
  const [marketSt,      setMarketSt]      = useState(() => getMarketStatus())
  const refreshTimerRef = useRef(null)
  const flashTimerRef   = useRef(null)

  // Update market status every minute
  useEffect(() => {
    const t = setInterval(() => setMarketSt(getMarketStatus()), 60_000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async (withRefresh = false) => {
    try {
      const token = await getToken()
      const url   = withRefresh ? '/api/brief?refresh=1' : '/api/brief'
      const res   = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 404) { setError('notGenerated'); setLoading(false); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setBrief(data.brief)
      setGeneratedAt(data.generatedAt)
      setIsOldBrief(data.generatedAt ? !sameCalendarDay(data.generatedAt, new Date().toISOString()) : false)
      setError(null)
      // Flash "just refreshed" indicator if server confirms a new generation
      if (data.justRefreshed) {
        setJustRefreshed(true)
        clearTimeout(flashTimerRef.current)
        flashTimerRef.current = setTimeout(() => setJustRefreshed(false), 8_000)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  // Initial load
  useEffect(() => { load(false) }, [load])

  // Intraday refresh: poll every 30min during market hours; server enforces 2hr generation gate
  useEffect(() => {
    const schedule = () => {
      refreshTimerRef.current = setInterval(() => {
        if (getMarketStatus().open) load(true)
      }, 30 * 60_000)  // check every 30min; server only regenerates if >2hrs old
    }
    schedule()
    return () => clearInterval(refreshTimerRef.current)
  }, [load])

  // Cleanup flash timer on unmount
  useEffect(() => () => clearTimeout(flashTimerRef.current), [])

  const biasColor = brief ? (BIAS_COLOR[brief.bias] || C.text || '#c8d8e8') : (C.dim || '#4a7a8a')
  const biasIcon  = brief ? (BIAS_ICON[brief.bias]  || '◆') : '◆'

  // Bias background: tint of the accent color, respects theme brightness
  const biasBg = brief?.bias
    ? `${BIAS_COLOR[brief.bias]}${C.isDark !== false ? '18' : '12'}`
    : 'transparent'

  const statusLabel = marketSt.open
    ? '🟢 Market open'
    : marketSt.reason === 'Market holiday' ? `🔴 ${marketSt.reason} · Reopens ${marketSt.nextLabel}`
    : marketSt.reason === 'Weekend'        ? `⚪ ${marketSt.reason} · Reopens ${marketSt.nextLabel}`
    : `⚫ ${marketSt.reason}${marketSt.nextLabel ? ' · ' + marketSt.nextLabel : ''}`

  const headerRight = generatedAt
    ? isOldBrief
      ? new Date(generatedAt).toLocaleDateString('en-US', { timeZone:'America/Chicago', weekday:'short', month:'short', day:'numeric' })
      : new Date(generatedAt).toLocaleTimeString('en-US', { timeZone:'America/Chicago', hour:'2-digit', minute:'2-digit' }) + ' CT'
    : ''

  const footerBriefLabel = generatedAt
    ? `${new Date(generatedAt).toLocaleDateString('en-US', { timeZone:'America/Chicago', weekday:'short', month:'short', day:'numeric' })} · ${new Date(generatedAt).toLocaleTimeString('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit' })} CT`
    : ''

  // ── Styles (all use theme tokens) ──────────────────────────────────────────
  const card        = { background: C.card || '#0d1a26', border: `1px solid ${C.border || '#1a2e3e'}`, borderRadius: C.radius || 8, overflow: 'hidden', fontFamily: 'Inter, sans-serif', boxShadow: C.shadow || 'none', transition: 'background 0.2s, border-color 0.2s' }
  const header      = { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:`1px solid ${C.border||'#1a2e3e'}`, background: C.cardAlt || '#0a1520', transition:'background 0.2s' }
  const headerLabel = { fontSize:11, fontWeight:700, letterSpacing:1.5, color: C.text || '#c8d8e8', fontFamily:'IBM Plex Mono, monospace' }
  const timeStyle   = { fontSize:10, color: C.dim || '#4a7a8a', fontFamily:'IBM Plex Mono, monospace' }
  const oldBadge    = { fontSize:9, fontWeight:700, letterSpacing:1, color:'#ff9500', background:'#ff950020', border:'1px solid #ff950040', borderRadius:3, padding:'2px 6px', fontFamily:'IBM Plex Mono, monospace' }
  const oldWarning  = { fontSize:10, color:'#ff9500', background:'#ff950010', borderBottom:`1px solid ${C.border||'#1a2e3e'}`, padding:'7px 16px', fontFamily:'IBM Plex Mono, monospace' }
  const flashBar    = { fontSize:10, color: C.isDark !== false ? '#00c85a' : '#007a3d', background: C.isDark !== false ? '#00c85a12' : '#007a3d0e', borderBottom:`1px solid ${C.border||'#1a2e3e'}`, padding:'6px 16px', fontFamily:'IBM Plex Mono, monospace', display:'flex', alignItems:'center', gap:6 }
  const biasBlock   = { margin:'12px 16px 0', borderRadius:6, border:`1px solid ${biasColor}55`, padding:'12px 14px', background: biasBg }
  const riskBlock   = { margin:'10px 16px 0', padding:'10px 14px', background: C.isDark !== false ? '#ff446610' : '#ff44660a', border:`1px solid ${C.isDark !== false ? '#ff446630' : '#ff446622'}`, borderRadius:6, display:'flex', alignItems:'flex-start' }
  const expandBtn   = { width:'100%', background:'transparent', border:'none', borderTop:`1px solid ${C.border||'#1a2e3e'}`, color: C.dim || '#4a7a8a', fontSize:10, fontWeight:700, letterSpacing:1.5, fontFamily:'IBM Plex Mono, monospace', padding:'10px', cursor:'pointer', marginTop:12 }
  const sectionTitle= { fontSize:10, fontWeight:700, letterSpacing:1.5, color: C.dim || '#4a7a8a', fontFamily:'IBM Plex Mono, monospace', marginBottom:8 }
  const bullet      = { display:'flex', gap:8, fontSize:11, color: C.text || '#c8d8e8', lineHeight:1.6, marginBottom:4 }
  const footer      = { fontSize:9, color: C.dim || '#4a7a8a', fontFamily:'IBM Plex Mono, monospace', padding:'8px 16px', borderTop:`1px solid ${C.border||'#1a2e3e'}`, textAlign:'center', marginTop:12, display:'flex', justifyContent:'center', alignItems:'center', flexWrap:'wrap', gap:4, opacity:0.7 }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={card}>
      <div style={header}><span style={headerLabel}>📊 MARKET READOUT</span></div>
      <div style={{ padding:16, display:'flex', flexDirection:'column', gap:8 }}>
        {[100, 60, 80].map((w,i) => (
          <div key={i} style={{ height:10, width:`${w}%`, background: C.border || '#1a2e3e', borderRadius:4, opacity:0.5 }} />
        ))}
      </div>
    </div>
  )

  if (error === 'notGenerated') return (
    <div style={card}>
      <div style={header}>
        <span style={headerLabel}>📊 MARKET READOUT</span>
        <span style={{ fontSize:9, color: marketSt.open ? '#00c85a' : C.dim || '#4a7a8a', fontFamily:'IBM Plex Mono, monospace' }}>{statusLabel}</span>
      </div>
      <div style={{ padding:'24px 16px', textAlign:'center' }}>
        <div style={{ fontSize:28, marginBottom:8 }}>🕐</div>
        <div style={{ fontSize:12, color: C.text || '#c8d8e8' }}>Today's readout generates at 8 AM CT</div>
        <div style={{ fontSize:10, color: C.dim || '#4a7a8a', fontFamily:'IBM Plex Mono, monospace', marginTop:4 }}>Use GENERATE to create one now</div>
      </div>
    </div>
  )

  if (error || !brief) return (
    <div style={card}>
      <div style={header}><span style={headerLabel}>📊 MARKET READOUT</span></div>
      <div style={{ padding:16, color:'#ff4466', fontSize:11, fontFamily:'IBM Plex Mono, monospace' }}>⚠ {error || 'Failed to load'}</div>
    </div>
  )

  return (
    <div style={card}>

      {/* Header */}
      <div style={header}>
        <span style={headerLabel}>📊 MARKET READOUT</span>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {isOldBrief && <span style={oldBadge}>PREV DAY</span>}
          <span style={timeStyle}>{headerRight}</span>
        </div>
      </div>

      {/* Just-refreshed flash bar */}
      {justRefreshed && (
        <div style={flashBar}>
          <span>⟳</span>
          <span>Readout updated · {new Date().toLocaleTimeString('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit' })} CT</span>
        </div>
      )}

      {/* Prev-day warning */}
      {isOldBrief && (
        <div style={oldWarning}>
          ⚠ Showing {new Date(generatedAt).toLocaleDateString('en-US', { timeZone:'America/Chicago', weekday:'short', month:'short', day:'numeric' })} readout — today's hasn't generated yet
        </div>
      )}

      {/* Bias — conclusion first */}
      <div style={biasBlock}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <span style={{ fontSize:16, color:biasColor, fontWeight:900 }}>{biasIcon}</span>
          <span style={{ fontSize:18, fontWeight:900, color:biasColor, fontFamily:'Bebas Neue, sans-serif', letterSpacing:2 }}>{brief.bias?.toUpperCase()}</span>
          <span style={{ fontSize:10, color: C.dim || '#4a7a8a', fontFamily:'IBM Plex Mono, monospace', marginLeft:'auto', textAlign:'right' }}>{brief.tone}</span>
        </div>
        <div style={{ fontSize:12, color: C.text || '#c8d8e8', lineHeight:1.5 }}>{brief.why}</div>
      </div>

      {/* Risk trigger */}
      <div style={riskBlock}>
        <span style={{ fontSize:9, fontWeight:700, color:'#ff6688', fontFamily:'IBM Plex Mono, monospace', flexShrink:0, paddingTop:1 }}>⚡ RISK TRIGGER</span>
        <span style={{ fontSize:11, color: C.text || '#c8d8e8', lineHeight:1.5, marginLeft:8 }}>{brief.risk_trigger}</span>
      </div>

      {/* Expand toggle */}
      <button onClick={() => setExpanded(e => !e)} style={expandBtn}>
        {expanded ? '▲ HIDE DETAILS' : '▼ SHOW DETAILS'}
      </button>

      {/* Expandable details */}
      {expanded && (
        <div style={{ padding:'0 16px 4px', borderTop:`1px solid ${C.border||'#1a2e3e'}` }}>
          <div style={{ paddingTop:12, paddingBottom:4 }}>
            <div style={sectionTitle}>📅 TODAY'S EVENTS</div>
            {(brief.events || []).map((ev,i) => (
              <div key={i} style={bullet}>
                <span style={{ color: C.green || '#00c85a', fontWeight:700, flexShrink:0 }}>•</span>
                <span>{ev}</span>
              </div>
            ))}
          </div>
          <div style={{ paddingTop:8, paddingBottom:4 }}>
            <div style={sectionTitle}>📍 KEY LEVELS</div>
            {(brief.levels || []).map((lv,i) => (
              <div key={i} style={bullet}>
                <span style={{ color: C.blue || '#00c8ff', fontWeight:700, flexShrink:0 }}>→</span>
                <span style={{ fontFamily:'IBM Plex Mono, monospace', fontSize:11 }}>{lv}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={footer}>
        <span>Last updated {footerBriefLabel}</span>
        <span style={{ margin:'0 6px', opacity:0.4 }}>·</span>
        <span style={{ color: marketSt.open ? (C.green || '#00c85a') : C.dim || '#4a7a8a', opacity: marketSt.open ? 0.8 : 1 }}>{statusLabel}</span>
        {marketSt.open && <span style={{ opacity:0.4 }}> · auto-updates every 2 hrs</span>}
      </div>

    </div>
  )
}
