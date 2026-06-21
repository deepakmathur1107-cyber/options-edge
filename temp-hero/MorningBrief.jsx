/**
 * src/components/MorningBrief.jsx
 * Market Readout — clean rewrite
 *
 * Features:
 * - Loads brief on mount (server auto-refreshes if ≥2hrs old)
 * - Breaking news ticker from Finnhub (refreshes every 30min, lightweight)
 * - Admin: REGENERATE NOW button for breaking news moments
 * - Theme-aware: all colors from C prop
 * - Responsive: 2-col events/levels on desktop, stacked on mobile
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const BIAS_COLOR   = { Bullish: '#00c85a', Neutral: '#f59e0b', Bearish: '#ef4444' }
const BIAS_BG_DK   = { Bullish: '#00c85a14', Neutral: '#f59e0b14', Bearish: '#ef444414' }
const BIAS_BG_LT   = { Bullish: '#dcfce7',   Neutral: '#fef9c3',   Bearish: '#fee2e2'   }
const BIAS_TEXT_LT = { Bullish: '#166534',   Neutral: '#92400e',   Bearish: '#991b1b'   }
const BIAS_ICON    = { Bullish: '▲', Neutral: '◆', Bearish: '▼' }

// ── NYSE Calendar (weekends + holidays) ──────────────────────────────────────
function nthWD(y,m,dow,n){const d=new Date(y,m-1,1);let c=0;while(true){if(d.getDay()===dow){c++;if(c===n)return new Date(d)}d.setDate(d.getDate()+1)}}
function lastWD(y,m,dow){const d=new Date(y,m,0);while(d.getDay()!==dow)d.setDate(d.getDate()-1);return new Date(d)}
function goodFriday(y){const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),dy=((h+l-7*m+114)%31)+1;const ea=new Date(y,mo-1,dy);ea.setDate(ea.getDate()-2);return ea}
function obs(d){const w=d.getDay();if(w===6)return new Date(d.getFullYear(),d.getMonth(),d.getDate()-1);if(w===0)return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1);return d}
function ymd(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function holidays(y){return new Set([ymd(obs(new Date(y,0,1))),ymd(nthWD(y,1,1,3)),ymd(nthWD(y,2,1,3)),ymd(goodFriday(y)),ymd(lastWD(y,5,1)),ymd(obs(new Date(y,5,19))),ymd(obs(new Date(y,6,4))),ymd(nthWD(y,9,1,1)),ymd(nthWD(y,11,4,4)),ymd(obs(new Date(y,11,25)))])}
function tzP(date,tz){return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'numeric',weekday:'short',hour12:false}).formatToParts(date).map(p=>[p.type,p.value]))}
function isTradingDay(d){const p=tzP(d,'America/New_York');if(p.weekday==='Sat'||p.weekday==='Sun')return false;return !holidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)}
function getMarketStatus(now=new Date()){
  if(!isTradingDay(now)){
    const p=tzP(now,'America/Chicago'),isHol=holidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)
    const nx=new Date(now);for(let i=1;i<=10;i++){nx.setDate(nx.getDate()+1);if(isTradingDay(nx))break}
    return{open:false,reason:isHol?'Market holiday':'Weekend',nextLabel:nx.toLocaleDateString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric'})}
  }
  const p=tzP(now,'America/New_York'),mins=parseInt(p.hour,10)*60+parseInt(p.minute,10)
  if(mins<9*60+30)return{open:false,reason:'Pre-market',nextLabel:'today at 9:30 AM ET'}
  if(mins>=16*60) return{open:false,reason:'After hours',nextLabel:'tomorrow 9:30 AM ET'}
  return{open:true,reason:'Market open',nextLabel:null}
}
function sameDay(a,b){
  const f=d=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d))
  return f(a)===f(b)
}
function fmtTime(iso){if(!iso)return'';return new Date(iso).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})+' CT'}
function fmtDate(iso){if(!iso)return'';return new Date(iso).toLocaleDateString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric'})}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MorningBrief({ getToken, theme, isAdmin, onBriefLoaded }) {
  const C    = theme || {}
  const dark = C.isDark !== false

  const [brief,          setBrief]          = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState(null)
  const [generatedAt,    setGeneratedAt]    = useState(null)
  const [isOldBrief,     setIsOldBrief]     = useState(false)
  const [justRefreshed,  setJustRefreshed]  = useState(false)
  const [marketSt,       setMarketSt]       = useState(() => getMarketStatus())
  const [news,           setNews]           = useState([])
  const [newsIdx,        setNewsIdx]        = useState(0)
  const [regenerating,   setRegenerating]   = useState(false)
  const [regenErr,       setRegenErr]       = useState('')
  const flashRef   = useRef(null)
  const tickerRef  = useRef(null)

  // Market status — update every minute
  useEffect(() => {
    const t = setInterval(() => setMarketSt(getMarketStatus()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Load brief from server — server handles 2hr auto-refresh logic
  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch('/api/brief', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 404) { setError('notGenerated'); setLoading(false); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setBrief(data.brief)
      setGeneratedAt(data.generatedAt)
      setIsOldBrief(data.isOldBrief || false)
      setError(null)
      // Dashboard's hero headline reads brief.why/brief.bias — pass it up rather
      // than have the hero fetch /api/brief a second time for the same data.
      onBriefLoaded?.(data.brief)
      if (data.justRefreshed) {
        setJustRefreshed(true)
        clearTimeout(flashRef.current)
        flashRef.current = setTimeout(() => setJustRefreshed(false), 8_000)
      }
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load() }, [load])

  // News ticker — lightweight GET, no auth, refreshes every 30min
  const loadNews = useCallback(async () => {
    try {
      const res = await fetch('/api/brief?news=1')
      if (!res.ok) return
      const data = await res.json()
      if (data.news?.length) setNews(data.news)
    } catch {}
  }, [])

  useEffect(() => {
    loadNews()
    const t = setInterval(loadNews, 30 * 60_000)
    return () => clearInterval(t)
  }, [loadNews])

  // Cycle ticker headlines every 6 seconds
  useEffect(() => {
    if (!news.length) return
    tickerRef.current = setInterval(() => setNewsIdx(i => (i + 1) % news.length), 6_000)
    return () => clearInterval(tickerRef.current)
  }, [news])

  // Admin: force regenerate
  const regenerate = async () => {
    setRegenerating(true); setRegenErr('')
    try {
      const token = await getToken()
      const res   = await fetch('/api/brief', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setBrief(data.brief)
      setGeneratedAt(data.generatedAt)
      setIsOldBrief(false)
      setJustRefreshed(true)
      clearTimeout(flashRef.current)
      flashRef.current = setTimeout(() => setJustRefreshed(false), 8_000)
    } catch (e) { setRegenErr(e.message) }
    finally { setRegenerating(false) }
  }

  useEffect(() => () => { clearTimeout(flashRef.current); clearInterval(tickerRef.current) }, [])

  // ── Theme values ─────────────────────────────────────────────────────────────
  const bias       = brief?.bias || 'Neutral'
  const biasColor  = BIAS_COLOR[bias]  || '#f59e0b'
  const biasBg     = dark ? (BIAS_BG_DK[bias] || '#f59e0b14') : (BIAS_BG_LT[bias] || '#fef9c3')
  const biasText   = dark ? biasColor : (BIAS_TEXT_LT[bias] || '#92400e')
  const cardBg     = C.card    || (dark ? '#0f1923' : '#ffffff')
  const cardAlt    = C.cardAlt || (dark ? '#162030' : '#f8fafc')
  const border     = C.border  || (dark ? '#1e2d3d' : '#e2e8f0')
  const textColor  = C.text    || (dark ? '#e2e8f0' : '#0f172a')
  const dimColor   = C.dim     || (dark ? '#64748b' : '#64748b')
  const greenColor = C.green   || '#00c85a'
  const blueColor  = C.blue    || '#3b82f6'
  const redColor   = C.red     || '#ef4444'

  const statusColor = marketSt.open ? greenColor : dimColor
  const statusDot   = marketSt.open ? '●' : '○'
  const statusText  = marketSt.open ? 'Market open'
    : marketSt.reason === 'Market holiday' ? `Holiday · Reopens ${marketSt.nextLabel}`
    : marketSt.reason === 'Weekend'        ? `Weekend · Reopens ${marketSt.nextLabel}`
    : `${marketSt.reason}${marketSt.nextLabel ? ' · ' + marketSt.nextLabel : ''}`

  // ── Skeleton ──────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:10,overflow:'hidden'}}>
      <div style={{padding:'12px 18px',background:cardAlt,borderBottom:`1px solid ${border}`,display:'flex',justifyContent:'space-between'}}>
        <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>📊 MARKET READOUT</span>
      </div>
      <div style={{padding:18,display:'flex',flexDirection:'column',gap:10}}>
        {[70,45,85,55].map((w,i)=><div key={i} style={{height:11,width:`${w}%`,background:border,borderRadius:4,opacity:.6}}/>)}
      </div>
    </div>
  )

  if (error === 'notGenerated') return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:10,overflow:'hidden'}}>
      <div style={{padding:'12px 18px',background:cardAlt,borderBottom:`1px solid ${border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:textColor,fontFamily:'IBM Plex Mono,monospace'}}>📊 MARKET READOUT</span>
        <span style={{fontSize:12,color:statusColor,fontFamily:'IBM Plex Mono,monospace'}}>{statusDot} {statusText}</span>
      </div>
      <div style={{padding:'28px 18px',textAlign:'center'}}>
        <div style={{fontSize:30,marginBottom:8}}>🕐</div>
        <div style={{fontSize:14,color:textColor,fontWeight:600,marginBottom:4}}>Readout generates at 7 AM CT</div>
        {isAdmin && <button onClick={regenerate} disabled={regenerating} style={{marginTop:10,background:greenColor,color:'#000',border:'none',borderRadius:4,padding:'6px 16px',fontSize:12,fontWeight:700,cursor:'pointer'}}>{regenerating?'Generating…':'Generate Now'}</button>}
      </div>
    </div>
  )

  if (error || !brief) return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:10,overflow:'hidden'}}>
      <div style={{padding:'12px 18px',background:cardAlt,borderBottom:`1px solid ${border}`}}>
        <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>📊 MARKET READOUT</span>
      </div>
      <div style={{padding:16,color:redColor,fontSize:13}}>⚠ {error || 'Failed to load'}</div>
    </div>
  )

  const currentNews = news[newsIdx]

  return (
    <div style={{background:cardBg,border:`1px solid ${border}`,borderRadius:10,overflow:'hidden',fontFamily:'Inter,sans-serif'}}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{padding:'11px 18px',background:cardAlt,borderBottom:`1px solid ${border}`,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:6}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:12,fontWeight:700,letterSpacing:2,color:textColor,fontFamily:'IBM Plex Mono,monospace'}}>📊 MARKET READOUT</span>
          <span style={{fontSize:10,fontWeight:400,color:dimColor,fontFamily:'IBM Plex Mono,monospace',letterSpacing:0}}>· news sentiment</span>
          {isOldBrief && <span style={{fontSize:10,fontWeight:700,color:'#f59e0b',background:'#f59e0b18',border:'1px solid #f59e0b40',borderRadius:3,padding:'2px 7px',fontFamily:'IBM Plex Mono,monospace'}}>PREV DAY</span>}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          {isAdmin && (
            <button onClick={regenerate} disabled={regenerating} style={{
              fontSize:10,fontWeight:700,letterSpacing:.5,fontFamily:'IBM Plex Mono,monospace',
              background:regenerating?'transparent':`${C.purple||'#a855f7'}18`,
              border:`1px solid ${regenerating?border:C.purple||'#a855f7'}`,
              color:regenerating?dimColor:C.purple||'#a855f7',
              padding:'3px 10px',borderRadius:3,cursor:regenerating?'not-allowed':'pointer'
            }}>{regenerating?'Generating…':'⟳ REGENERATE'}</button>
          )}
          <span style={{fontSize:12,color:statusColor,fontFamily:'IBM Plex Mono,monospace',fontWeight:600}}>{statusDot} {statusText}</span>
          <span style={{fontSize:11,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>{isOldBrief ? fmtDate(generatedAt) : fmtTime(generatedAt)}</span>
        </div>
      </div>

      {/* ── News ticker ────────────────────────────────────────────────────── */}
      {currentNews && (
        <div style={{padding:'6px 18px',background:dark?C.bgDeep:C.bgAlt,borderBottom:`1px solid ${border}`,display:'flex',alignItems:'center',gap:8,overflow:'hidden'}}>
          <span style={{fontSize:10,fontWeight:700,color:blueColor,fontFamily:'IBM Plex Mono,monospace',flexShrink:0,letterSpacing:.5}}>LIVE</span>
          <span style={{fontSize:11,color:textColor,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{currentNews.headline}</span>
          <span style={{fontSize:10,color:dimColor,fontFamily:'IBM Plex Mono,monospace',flexShrink:0}}>{currentNews.source}</span>
        </div>
      )}

      {/* ── Refresh flash ──────────────────────────────────────────────────── */}
      {justRefreshed && (
        <div style={{padding:'7px 18px',background:dark?`${greenColor}10`:'#dcfce7',borderBottom:`1px solid ${dark?`${greenColor}25`:'#bbf7d0'}`,display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:12,color:greenColor}}>⟳</span>
          <span style={{fontSize:11,color:dark?greenColor:'#166534',fontFamily:'IBM Plex Mono,monospace'}}>Readout updated · {fmtTime(generatedAt)}</span>
        </div>
      )}

      {/* ── Regen error ────────────────────────────────────────────────────── */}
      {regenErr && (
        <div style={{padding:'7px 18px',background:dark?`${redColor}10`:'#fee2e2',borderBottom:`1px solid ${border}`,fontSize:11,color:redColor,fontFamily:'IBM Plex Mono,monospace'}}>
          ⚠ {regenErr}
        </div>
      )}

      {/* ── Prev-day warning ───────────────────────────────────────────────── */}
      {isOldBrief && (
        <div style={{padding:'7px 18px',background:dark?'#f59e0b0d':'#fef9c3',borderBottom:`1px solid ${dark?'#f59e0b25':'#fde68a'}`,fontSize:11,color:dark?'#f59e0b':'#92400e',fontFamily:'IBM Plex Mono,monospace'}}>
          ⚠ Showing {fmtDate(generatedAt)} readout — today's generates at 7 AM CT
        </div>
      )}

      {/* ── Bias banner ────────────────────────────────────────────────────── */}
      <div style={{padding:'18px 18px 14px',background:biasBg,borderBottom:`1px solid ${border}`}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,flexWrap:'wrap'}}>
          <span style={{fontSize:28,color:biasColor,lineHeight:1}}>{BIAS_ICON[bias]}</span>
          <span style={{fontSize:30,fontWeight:900,color:biasColor,fontFamily:'Bebas Neue,sans-serif',letterSpacing:3,lineHeight:1}}>{bias.toUpperCase()}</span>
          <div style={{display:'flex',gap:5,flexWrap:'wrap',marginLeft:'auto'}}>
            {(brief.tone||'').split('/').map((t,i)=>(
              <span key={i} style={{fontSize:10,color:biasText,background:dark?`${biasColor}18`:`${biasColor}20`,border:`1px solid ${biasColor}40`,borderRadius:4,padding:'3px 8px',fontWeight:600,letterSpacing:.5,whiteSpace:'nowrap'}}>{t.trim()}</span>
            ))}
          </div>
        </div>
        <div style={{fontSize:14,color:textColor,lineHeight:1.6,fontWeight:500}}>{brief.why}</div>
      </div>

      {/* ── Risk trigger ───────────────────────────────────────────────────── */}
      <div style={{padding:'10px 18px',background:dark?'#ef444408':'#fef2f2',borderBottom:`1px solid ${dark?'#ef444425':'#fecaca'}`,display:'flex',alignItems:'flex-start',gap:10}}>
        <span style={{fontSize:10,fontWeight:800,color:redColor,fontFamily:'IBM Plex Mono,monospace',letterSpacing:1,flexShrink:0,paddingTop:2}}>⚡ RISK</span>
        <span style={{fontSize:13,color:dark?'#fca5a5':'#991b1b',lineHeight:1.5}}>{brief.risk_trigger}</span>
      </div>

      {/* ── Events + Levels (2-col desktop) ────────────────────────────────── */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',borderBottom:`1px solid ${border}`}}>
        <div style={{padding:'14px 18px',borderRight:`1px solid ${border}`}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace',marginBottom:10,textTransform:'uppercase'}}>📅 Events</div>
          {(brief.events||[]).map((ev,i)=>(
            <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:6}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:greenColor,flexShrink:0,marginTop:5}}/>
              <span style={{fontSize:13,color:textColor,lineHeight:1.5}}>{ev}</span>
            </div>
          ))}
        </div>
        <div style={{padding:'14px 18px'}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace',marginBottom:10,textTransform:'uppercase'}}>📍 Key Levels</div>
          {(brief.levels||[]).map((lv,i)=>(
            <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:6}}>
              <span style={{fontSize:12,color:blueColor,flexShrink:0,fontWeight:700}}>→</span>
              <span style={{fontSize:13,color:textColor,fontFamily:'IBM Plex Mono,monospace',lineHeight:1.5}}>{lv}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div style={{padding:'7px 18px',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:4}}>
        <span style={{fontSize:10,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>Updated {fmtDate(generatedAt)} · {fmtTime(generatedAt)}</span>
        <span style={{fontSize:10,color:dimColor,fontFamily:'IBM Plex Mono,monospace',opacity:.6}}>
          {marketSt.open ? 'auto-refreshes every 2 hrs' : statusText}
        </span>
      </div>

    </div>
  )
}
