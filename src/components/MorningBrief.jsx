/**
 * src/components/MorningBrief.jsx
 * Market Readout — system-controlled, refreshes every 2hrs during market hours
 * Design: Bloomberg war-room — bias dominates, data visible, readable at desktop scale
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const BIAS_COLOR  = { Bullish: '#00c85a', Neutral: '#f59e0b', Bearish: '#ef4444' }
const BIAS_BG_DK  = { Bullish: '#00c85a14', Neutral: '#f59e0b14', Bearish: '#ef444414' }
const BIAS_BG_LT  = { Bullish: '#dcfce7',   Neutral: '#fef9c3',   Bearish: '#fee2e2'   }
const BIAS_TEXT_LT= { Bullish: '#166534',   Neutral: '#92400e',   Bearish: '#991b1b'   }
const BIAS_ICON   = { Bullish: '▲', Neutral: '◆', Bearish: '▼' }
const BIAS_LABEL  = { Bullish: 'BULLISH', Neutral: 'NEUTRAL', Bearish: 'BEARISH' }

// ── NYSE Holiday Calendar ───────────────────────────────────────────────────
function nthWeekday(year, month, dow, n) {
  const d = new Date(year, month-1, 1); let count = 0
  while (true) { if (d.getDay()===dow) { count++; if (count===n) return new Date(d) } d.setDate(d.getDate()+1) }
}
function lastWeekday(year, month, dow) {
  const d = new Date(year, month, 0); while (d.getDay()!==dow) d.setDate(d.getDate()-1); return new Date(d)
}
function goodFriday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451)
  const month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1
  const easter=new Date(year,month-1,day); easter.setDate(easter.getDate()-2); return easter
}
function observed(d) { const w=d.getDay(); if(w===6) return new Date(d.getFullYear(),d.getMonth(),d.getDate()-1); if(w===0) return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1); return d }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
function getHolidays(year) {
  return new Set([ymd(observed(new Date(year,0,1))),ymd(nthWeekday(year,1,1,3)),ymd(nthWeekday(year,2,1,3)),
    ymd(goodFriday(year)),ymd(lastWeekday(year,5,1)),ymd(observed(new Date(year,5,19))),
    ymd(observed(new Date(year,6,4))),ymd(nthWeekday(year,9,1,1)),ymd(nthWeekday(year,11,4,4)),ymd(observed(new Date(year,11,25)))])
}
function tzParts(date, tz) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'numeric',weekday:'short',hour12:false}).formatToParts(date).map(p=>[p.type,p.value]))
}
function isTradingDay(date) {
  const p = tzParts(date,'America/New_York')
  if (p.weekday==='Sat'||p.weekday==='Sun') return false
  return !getHolidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)
}
function getMarketStatus(now=new Date()) {
  if (!isTradingDay(now)) {
    const p=tzParts(now,'America/Chicago'),isHoliday=getHolidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)
    const next=new Date(now); for(let i=1;i<=10;i++){next.setDate(next.getDate()+1);if(isTradingDay(next))break}
    return {open:false,reason:isHoliday?'Market holiday':'Weekend',nextLabel:next.toLocaleDateString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric'})}
  }
  const p=tzParts(now,'America/New_York'),mins=parseInt(p.hour,10)*60+parseInt(p.minute,10)
  if (mins<9*60+30) return {open:false,reason:'Pre-market',nextLabel:'today at 9:30 AM ET'}
  if (mins>=16*60)  return {open:false,reason:'After hours',nextLabel:'tomorrow 9:30 AM ET'}
  return {open:true,reason:'Market open',nextLabel:null}
}
function sameCalendarDay(a,b) {
  const fmt=d=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d))
  return fmt(a)===fmt(b)
}

// ── Component ───────────────────────────────────────────────────────────────
export default function MorningBrief({ getToken, theme }) {
  const C    = theme || {}
  const dark = C.isDark !== false

  const [brief,         setBrief]         = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [generatedAt,   setGeneratedAt]   = useState(null)
  const [isOldBrief,    setIsOldBrief]    = useState(false)
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [marketSt,      setMarketSt]      = useState(() => getMarketStatus())

  const flashTimerRef   = useRef(null)

  useEffect(() => {
    const t = setInterval(() => setMarketSt(getMarketStatus()), 60_000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async (withRefresh = false) => {
    try {
      const token = await getToken()
      const res   = await fetch(withRefresh ? '/api/brief?refresh=1' : '/api/brief', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 404) { setError('notGenerated'); setLoading(false); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setBrief(data.brief)
      setGeneratedAt(data.generatedAt)
      setIsOldBrief(data.generatedAt ? !sameCalendarDay(data.generatedAt, new Date().toISOString()) : false)
      setError(null)
      if (data.justRefreshed) {
        setJustRefreshed(true)
        clearTimeout(flashTimerRef.current)
        flashTimerRef.current = setTimeout(() => setJustRefreshed(false), 8_000)
      }
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load(false) }, [load])

  // No client polling needed — server auto-refreshes on every GET if brief is ≥2hrs old

  useEffect(() => () => clearTimeout(flashTimerRef.current), [])

  const bias      = brief?.bias || 'Neutral'
  const biasColor = BIAS_COLOR[bias]  || '#f59e0b'
  const biasBg    = dark ? (BIAS_BG_DK[bias] || '#f59e0b14') : (BIAS_BG_LT[bias] || '#fef9c3')
  const biasText  = dark ? biasColor : (BIAS_TEXT_LT[bias] || '#92400e')

  // Derived theme values with safe fallbacks
  const cardBg     = C.card     || (dark ? '#0d1a26' : '#ffffff')
  const cardAlt    = C.cardAlt  || (dark ? '#0a1520' : '#f8fafc')
  const border     = C.border   || (dark ? '#1a2e3e' : '#e2e8f0')
  const textColor  = C.text     || (dark ? '#c8d8e8' : '#1a2e3e')
  const dimColor   = C.dim      || (dark ? '#4a7a8a' : '#64748b')
  const greenColor = C.green    || '#00c85a'
  const blueColor  = C.blue     || '#00c8ff'
  const shadow     = C.shadow   || (dark ? '0 4px 12px rgba(0,0,0,.4)' : '0 4px 12px rgba(0,0,0,.08)')
  const radius     = C.radius   || '10px'

  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'}) + ' CT' : ''
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric'}) : ''

  const statusDot   = marketSt.open ? '●' : '○'
  const statusColor = marketSt.open ? greenColor : dimColor
  const statusText  = marketSt.open ? 'Market open'
    : marketSt.reason === 'Market holiday' ? `Holiday · ${marketSt.nextLabel}`
    : marketSt.reason === 'Weekend'        ? `Weekend · ${marketSt.nextLabel}`
    : `${marketSt.reason} · ${marketSt.nextLabel || ''}`

  // ── Skeletons ──────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:radius,overflow:'hidden',boxShadow:shadow}}>
      <div style={{padding:'14px 20px',borderBottom:`1px solid ${border}`,background:cardAlt,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>MARKET READOUT</span>
      </div>
      <div style={{padding:'20px',display:'flex',flexDirection:'column',gap:12}}>
        {[70,45,85,55].map((w,i)=>(
          <div key={i} style={{height:12,width:`${w}%`,background:border,borderRadius:4,opacity:0.6,animation:'pulse 1.5s ease-in-out infinite'}}/>
        ))}
      </div>
    </div>
  )

  if (error === 'notGenerated') return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:radius,overflow:'hidden',boxShadow:shadow}}>
      <div style={{padding:'14px 20px',borderBottom:`1px solid ${border}`,background:cardAlt,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>MARKET READOUT</span>
        <span style={{fontSize:11,color:statusColor,fontFamily:'IBM Plex Mono,monospace'}}>{statusDot} {statusText}</span>
      </div>
      <div style={{padding:'32px 20px',textAlign:'center'}}>
        <div style={{fontSize:32,marginBottom:10}}>🕐</div>
        <div style={{fontSize:15,color:textColor,fontWeight:600,marginBottom:6}}>Today's readout generates at 7 AM CT</div>
        <div style={{fontSize:13,color:dimColor}}>Use GENERATE to create one now</div>
      </div>
    </div>
  )

  if (error || !brief) return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:radius,overflow:'hidden',boxShadow:shadow}}>
      <div style={{padding:'14px 20px',borderBottom:`1px solid ${border}`,background:cardAlt}}>
        <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>MARKET READOUT</span>
      </div>
      <div style={{padding:'16px 20px',color:'#ef4444',fontSize:13}}>⚠ {error || 'Failed to load'}</div>
    </div>
  )

  return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:radius,overflow:'hidden',boxShadow:shadow,fontFamily:'Inter,sans-serif'}}>

      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div style={{padding:'12px 20px',borderBottom:`1px solid ${border}`,background:cardAlt,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:textColor,fontFamily:'IBM Plex Mono,monospace'}}>📊 MARKET READOUT</span>
          {isOldBrief && <span style={{fontSize:10,fontWeight:700,color:'#f59e0b',background:'#f59e0b18',border:'1px solid #f59e0b40',borderRadius:4,padding:'2px 7px',fontFamily:'IBM Plex Mono,monospace',letterSpacing:1}}>PREV DAY</span>}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <span style={{fontSize:12,color:statusColor,fontFamily:'IBM Plex Mono,monospace',fontWeight:600}}>{statusDot} {statusText}</span>
          <span style={{fontSize:11,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>{isOldBrief ? fmtDate(generatedAt) : fmtTime(generatedAt)}</span>
        </div>
      </div>

      {/* ── Refresh flash ──────────────────────────────────────────────────── */}
      {justRefreshed && (
        <div style={{padding:'8px 20px',background:dark?`${greenColor}10`:'#dcfce7',borderBottom:`1px solid ${dark?`${greenColor}25`:'#bbf7d0'}`,display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:13,color:greenColor}}>⟳</span>
          <span style={{fontSize:12,color:dark?greenColor:'#166534',fontFamily:'IBM Plex Mono,monospace'}}>Readout refreshed · {fmtTime(new Date().toISOString())}</span>
        </div>
      )}

      {/* ── Prev-day warning ───────────────────────────────────────────────── */}
      {isOldBrief && (
        <div style={{padding:'8px 20px',background:dark?'#f59e0b0e':'#fef9c3',borderBottom:`1px solid ${dark?'#f59e0b25':'#fde68a'}`,fontSize:12,color:dark?'#f59e0b':'#92400e',fontFamily:'IBM Plex Mono,monospace'}}>
          ⚠ Showing {fmtDate(generatedAt)} · today's hasn't generated yet
        </div>
      )}

      {/* ── Bias banner ────────────────────────────────────────────────────── */}
      <div style={{padding:'20px 20px 16px',background:biasBg,borderBottom:`1px solid ${border}`}}>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:10,flexWrap:'wrap'}}>
          {/* Big bias call */}
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:28,color:biasColor,lineHeight:1}}>{BIAS_ICON[bias]}</span>
            <span style={{fontSize:32,fontWeight:900,color:biasColor,fontFamily:'Bebas Neue,sans-serif',letterSpacing:3,lineHeight:1}}>{BIAS_LABEL[bias]}</span>
          </div>
          {/* Tone tags */}
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginLeft:'auto'}}>
            {(brief.tone||'').split('/').map((t,i)=>(
              <span key={i} style={{fontSize:11,color:biasText,background:dark?`${biasColor}18`:`${biasColor}20`,border:`1px solid ${biasColor}40`,borderRadius:4,padding:'3px 8px',fontWeight:600,letterSpacing:0.5,whiteSpace:'nowrap'}}>
                {t.trim()}
              </span>
            ))}
          </div>
        </div>
        {/* Why */}
        <div style={{fontSize:15,color:textColor,lineHeight:1.6,fontWeight:500}}>{brief.why}</div>
      </div>

      {/* ── Risk trigger ───────────────────────────────────────────────────── */}
      <div style={{padding:'12px 20px',background:dark?'#ef444408':'#fef2f2',borderBottom:`1px solid ${dark?'#ef444425':'#fecaca'}`,display:'flex',alignItems:'flex-start',gap:10}}>
        <span style={{fontSize:10,fontWeight:800,color:'#ef4444',fontFamily:'IBM Plex Mono,monospace',letterSpacing:1,flexShrink:0,paddingTop:2,whiteSpace:'nowrap'}}>⚡ RISK</span>
        <span style={{fontSize:14,color:dark?'#fca5a5':'#991b1b',lineHeight:1.5}}>{brief.risk_trigger}</span>
      </div>

      {/* ── Events + Levels (always visible, 2-col on desktop) ─────────────── */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:0,borderBottom:`1px solid ${border}`}}>

        {/* Today's Events */}
        <div style={{padding:'16px 20px',borderRight:`1px solid ${border}`}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace',marginBottom:12,textTransform:'uppercase'}}>📅 Today's Events</div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {(brief.events||[]).map((ev,i)=>(
              <div key={i} style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:greenColor,flexShrink:0,marginTop:5}}/>
                <span style={{fontSize:13,color:textColor,lineHeight:1.5}}>{ev}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Key Levels */}
        <div style={{padding:'16px 20px'}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace',marginBottom:12,textTransform:'uppercase'}}>📍 Key Levels</div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {(brief.levels||[]).map((lv,i)=>(
              <div key={i} style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                <span style={{fontSize:12,color:blueColor,flexShrink:0,marginTop:1,fontWeight:700}}>→</span>
                <span style={{fontSize:13,color:textColor,fontFamily:'IBM Plex Mono,monospace',lineHeight:1.5}}>{lv}</span>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div style={{padding:'8px 20px',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:4}}>
        <span style={{fontSize:11,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>
          Updated {fmtDate(generatedAt)} · {fmtTime(generatedAt)}
        </span>
        {marketSt.open && (
          <span style={{fontSize:11,color:dimColor,fontFamily:'IBM Plex Mono,monospace',opacity:0.6}}>
            auto-refreshes every 2 hrs
          </span>
        )}
      </div>

    </div>
  )
}
