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

// ── NYSE Calendar + session detection moved to src/lib/marketSession.js —
// shared with the Dashboard's News Read / Price Read cards so all three
// surfaces agree on the same pre-market/open/after-hours boundaries instead
// of each computing it independently. ──
import { getMarketStatus } from '../lib/marketSession'
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
  // biasColor/biasBg/biasText/BIAS_ICON are currently unused — this card no
  // longer displays bias directly (moved to the Dashboard hero). Kept rather
  // than deleted in case a future view wants a bias-colored accent here.
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

      {/* Bias banner + risk trigger live in the Dashboard hero (same
          brief.why/bias/risk_trigger data, via onBriefLoaded). Removed the
          strip that used to restate BULLISH/tone here too — the hero already
          states the conclusion; this card's job is to be the supporting
          evidence (news + events + levels), not repeat the verdict. */}

      {/* ── What's happening: live news + events, merged into one column ── */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',borderBottom:`1px solid ${border}`}}>
        <div style={{padding:'14px 18px',borderRight:`1px solid ${border}`}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:2,color:dimColor,fontFamily:'IBM Plex Mono,monospace',marginBottom:10,textTransform:'uppercase'}}>📰 What's happening</div>
          {currentNews && (
            <div style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:8,paddingBottom:8,borderBottom:`1px solid ${border}`}}>
              <span style={{fontSize:9,fontWeight:700,color:blueColor,fontFamily:'IBM Plex Mono,monospace',flexShrink:0,letterSpacing:.5,marginTop:2}}>LIVE</span>
              <span style={{fontSize:13,color:textColor,lineHeight:1.5}}>{currentNews.headline} <span style={{fontSize:10,color:dimColor,fontFamily:'IBM Plex Mono,monospace'}}>{currentNews.source}</span></span>
            </div>
          )}
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
