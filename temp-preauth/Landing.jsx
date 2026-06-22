import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { DARK_THEME, LIGHT_THEME } from './theme'

// Pre-auth pages now follow the same persisted isDark preference as the
// authenticated app, instead of being permanently dark regardless of the
// user's choice — read directly from localStorage since Landing renders at
// a route level with no parent component naturally passing theme down.
const ls = (key, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

const MONO = "'IBM Plex Mono', 'Courier New', monospace"
const SANS = "'Inter', system-ui, sans-serif"
const SERIF = "'Fraunces', serif"

// ── Mock scanner data ─────────────────────────────────────────────────────────
const getMockAlerts = (C) => [
  { symbol:'SPY',  type:'CALL', strike:545, dte:21, score:88, mid:3.42, grade:'A', color:C.green },
  { symbol:'NVDA', type:'CALL', strike:135, dte:28, score:82, mid:4.15, grade:'A', color:C.green },
  { symbol:'QQQ',  type:'PUT',  strike:455, dte:14, score:76, mid:2.88, grade:'B', color:C.blue },
  { symbol:'TSLA', type:'CALL', strike:265, dte:35, score:71, mid:5.60, grade:'B', color:C.blue },
  { symbol:'AAPL', type:'CALL', strike:215, dte:21, score:68, mid:2.10, grade:'B', color:C.blue },
]

const getFeatures = (C) => [
  { icon:'⚡', title:'Conviction Scoring',    desc:'Every contract scored 0–100 using GEX, delta, IV, liquidity, and direction. Only high-conviction setups make it through.', color:C.green },
  { icon:'🛡', title:'6 Hard-Block Filters',  desc:'Kills chasing trades, IV traps, morning noise, DTE crush, and no-catalyst setups automatically before you see them.', color:C.blue },
  { icon:'📊', title:'Morning AI Readout',    desc:'Daily pre-market brief with market bias, key levels, and risk triggers. Generated fresh every morning from live data.', color:C.orange },
  { icon:'📈', title:'Structure Intelligence',desc:'Recommends naked, spread, condor, or butterfly based on IV environment and directional conviction.', color:C.green },
  { icon:'📋', title:'Trade Journal',         desc:'Log trades with one tap. Track win rate by conviction band, IV level, and strategy over time.', color:C.blue },
  { icon:'🔔', title:'Email & SMS Alerts',    desc:'Push notifications the moment a high-conviction setup hits your threshold.', color:C.orange },
]

const FAQS = [
  { q:'Do I need a brokerage account?',         a:'No. Options Edge provides trade ideas and analytics. You execute through your own broker — TD Ameritrade, IBKR, Tastytrade, etc.' },
  { q:'Where does the market data come from?',  a:'Live options chain data via Tradier API — real bid/ask, Greeks, open interest, and volume on every scan.' },
  { q:'What happens after the free trial?',     a:"You're charged $19/month after 7 days. Cancel anytime before then and you won't be charged. Your journal data is always preserved." },
  { q:'Is this financial advice?',              a:'No. Options Edge is an analytical tool. All setups are generated algorithmically. You are solely responsible for your trading decisions.' },
  { q:'What makes this different from a screener?', a:"Screeners show you what moved. Options Edge scores why a specific contract makes sense right now — then blocks the trades that look good but historically lose." },
]

// ── Animated scanner mockup ───────────────────────────────────────────────────
function ScannerMockup({ C }) {
  const [active, setActive] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)
  const MOCK_ALERTS = getMockAlerts(C)

  useEffect(() => {
    const cycle = setInterval(() => {
      setScanning(true)
      setProgress(0)
      let p = 0
      const prog = setInterval(() => {
        p += 12
        setProgress(Math.min(p, 100))
        if (p >= 100) {
          clearInterval(prog)
          setScanning(false)
          setActive(a => (a + 1) % MOCK_ALERTS.length)
        }
      }, 80)
    }, 3200)
    return () => clearInterval(cycle)
  }, [])

  const alert = MOCK_ALERTS[active]

  return (
    <div style={{ background:C.bgDeep, border:`1px solid ${C.border}`, borderRadius:10, overflow:'hidden', fontFamily:MONO, fontSize:11, boxShadow:C.shadowLg }}>
      {/* Title bar */}
      <div style={{ background:C.cardAlt, borderBottom:`1px solid ${C.border}`, padding:'10px 14px', display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#ff5f57' }} />
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#febc2e' }} />
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#28c840' }} />
        <span style={{ marginLeft:8, color:C.dim, fontSize:10, letterSpacing:1 }}>OPTIONS EDGE — AUTO SCANNER</span>
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background: scanning ? C.orange : C.green, boxShadow: scanning ? `0 0 6px ${C.orange}` : `0 0 6px ${C.green}` }} />
          <span style={{ color: scanning ? C.orange : C.green, fontSize:9, letterSpacing:1 }}>{scanning ? 'SCANNING' : 'LIVE'}</span>
        </div>
      </div>
      {scanning && (
        <div style={{ height:2, background:C.cardAlt }}>
          <div style={{ height:'100%', background:`linear-gradient(90deg,${C.green},${C.blue})`, width:progress+'%', transition:'width 0.08s linear' }} />
        </div>
      )}
      {/* Watchlist pills */}
      <div style={{ padding:'8px 14px', borderBottom:`1px solid ${C.borderDim}`, display:'flex', gap:5, flexWrap:'wrap' }}>
        {['SPY','QQQ','NVDA','TSLA','AAPL','META','AMZN','IWM'].map(s => (
          <span key={s} style={{ fontSize:9, color: s===alert.symbol ? C.green : C.dim, background: s===alert.symbol ? `${C.green}15` : 'transparent', border:'1px solid '+(s===alert.symbol ? `${C.green}40` : C.borderDim), borderRadius:3, padding:'2px 6px', transition:'all 0.3s' }}>{s}</span>
        ))}
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim }}>SWING 21–45D</span>
      </div>
      {/* Column headers */}
      <div style={{ padding:'5px 14px', display:'flex', alignItems:'center', gap:8, borderBottom:`1px solid ${C.borderDim}` }}>
        {['SYMBOL','CONTRACT','DTE','CONVICTION','GRD','MID'].map((h,i) => (
          <span key={i} style={{ fontSize:8, color:C.dim, letterSpacing:1, flex: h==='CONVICTION'?1:'none', width: h==='SYMBOL'?36:h==='CONTRACT'?68:h==='DTE'?24:h==='GRD'?22:36 }}>{h}</span>
        ))}
      </div>
      {/* Rows */}
      <div style={{ padding:'4px 0' }}>
        {MOCK_ALERTS.map((a, i) => (
          <div key={i} style={{ padding:'7px 14px', display:'flex', alignItems:'center', gap:8, background: i===active ? `${C.green}10` : 'transparent', borderLeft:'2px solid '+(i===active ? a.color : 'transparent'), transition:'all 0.4s', opacity: i===active ? 1 : 0.3 }}>
            <span style={{ color:a.color, fontWeight:700, width:36, fontSize:12 }}>{a.symbol}</span>
            <span style={{ color:C.text, width:68, fontSize:10 }}>{a.type} {a.strike}</span>
            <span style={{ color:C.dim, width:24, fontSize:10 }}>{a.dte}D</span>
            <div style={{ flex:1, display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ flex:1, height:3, background:C.border, borderRadius:2, overflow:'hidden' }}>
                <div style={{ height:'100%', width: i===active ? a.score+'%' : '0%', background:'linear-gradient(90deg,'+a.color+'80,'+a.color+')', transition:'width 0.6s ease', borderRadius:2 }} />
              </div>
              <span style={{ color:a.color, fontWeight:700, width:22, textAlign:'right', fontSize:10 }}>{a.score}</span>
            </div>
            <div style={{ background:a.color+'20', border:'1px solid '+a.color+'50', borderRadius:3, padding:'1px 5px', color:a.color, fontWeight:700, fontSize:10, width:22, textAlign:'center' }}>{a.grade}</div>
            <span style={{ color:C.text, width:36, textAlign:'right', fontSize:10 }}>${a.mid}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop:`1px solid ${C.borderDim}`, padding:'7px 14px', display:'flex', justifyContent:'space-between', color:C.dim, fontSize:8, letterSpacing:1 }}>
        <span>TRADIER LIVE DATA</span>
        <span>GEX + OI + VOLUME</span>
        <span>NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  )
}

// ── Morning Brief mockup ──────────────────────────────────────────────────────
function BriefMockup({ C }) {
  return (
    <div style={{ background:C.bgDeep, border:`1px solid ${C.border}`, borderRadius:8, overflow:'hidden', fontFamily:MONO, fontSize:11 }}>
      <div style={{ background:C.cardAlt, borderBottom:`1px solid ${C.border}`, padding:'10px 14px', display:'flex', justifyContent:'space-between' }}>
        <span style={{ color:C.text, fontWeight:700, letterSpacing:1.5, fontSize:10 }}>📊 MORNING READOUT</span>
        <span style={{ color:C.dim, fontSize:9 }}>08:42 CT</span>
      </div>
      <div style={{ padding:14 }}>
        <div style={{ background:`${C.green}12`, border:`1px solid ${C.green}30`, borderRadius:6, padding:'10px 12px', marginBottom:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
            <span style={{ color:C.green, fontSize:16, fontWeight:900 }}>▲</span>
            <span style={{ color:C.green, fontFamily:SERIF, fontWeight:600, fontSize:16 }}>Bullish</span>
            <span style={{ color:C.dim, fontSize:9, marginLeft:'auto' }}>Risk-on / Tech-led</span>
          </div>
          <div style={{ color:C.text, fontSize:11, lineHeight:1.6 }}>Fed hold confirmed. Tech earnings beat driving broad risk appetite into the session.</div>
        </div>
        <div style={{ background:`${C.red}10`, border:`1px solid ${C.red}30`, borderRadius:6, padding:'8px 12px', display:'flex', gap:8, alignItems:'flex-start' }}>
          <span style={{ color:C.red, fontSize:9, fontWeight:700, flexShrink:0 }}>⚡ RISK TRIGGER</span>
          <span style={{ color:C.text, fontSize:10, lineHeight:1.5, marginLeft:4 }}>Hot CPI or hawkish Fed speaker reverses rally</span>
        </div>
      </div>
    </div>
  )
}

// ── Main Landing ──────────────────────────────────────────────────────────────
export default function Landing() {
  const navigate = useNavigate()
  const [openFaq, setOpenFaq] = useState(null)
  const [isDark, setIsDark] = useState(() => ls('isDark', '1') === '1')
  const C = isDark ? DARK_THEME : LIGHT_THEME

  // Stay in sync if the user toggles theme in another tab (e.g. already
  // logged into the app elsewhere) — same persisted preference either way.
  useEffect(() => {
    const onStorage = () => setIsDark(ls('isDark', '1') === '1')
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Same CSS-variable bridge as AuthShell (Router.jsx) — Landing manages its
  // own isDark independently, so without this, --page-bg etc. would be
  // unset or stale from whatever route was visited previously.
  useEffect(() => {
    document.documentElement.style.background = C.bg
    document.documentElement.style.setProperty('--page-bg', C.bg)
    document.documentElement.style.setProperty('--page-text', C.text)
    document.documentElement.style.setProperty('--page-bg-deep', C.bgDeep)
    document.documentElement.style.setProperty('--page-border', C.border)
    document.documentElement.style.setProperty('--expand-chevron-color', C.orange)
    document.documentElement.style.setProperty('--expand-hint-color', C.dim)
  }, [isDark, C])

  return (
    <div style={{ background:C.bg, color:C.text, fontFamily:SANS, minHeight:'100vh', overflowX:'hidden' }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
        a { color: inherit; text-decoration: none }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-thumb { background: ${C.border} }

        .btn-primary {
          background: ${C.green}20; border: 1px solid ${C.green}; color: ${C.green};
          padding: 14px 28px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: ${SANS}; font-weight: 600; letter-spacing: 0.5px; transition: all 0.2s; white-space: nowrap;
          -webkit-tap-highlight-color: transparent;
        }
        .btn-primary:hover, .btn-primary:active { background: ${C.green}35; }
        .btn-secondary {
          background: transparent; border: 1px solid ${C.border}; color: ${C.dim};
          padding: 14px 24px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: ${SANS}; font-weight: 600; letter-spacing: 0.5px; transition: all 0.2s;
          -webkit-tap-highlight-color: transparent;
        }
        .btn-secondary:hover, .btn-secondary:active { border-color: ${C.subtext}; color: ${C.subtext}; }
        .feature-card {
          background: ${C.card}; border: 1px solid ${C.border}; border-radius: 8px;
          padding: 22px; transition: border-color 0.2s; box-shadow: ${C.shadow};
        }
        .feature-card:hover { border-color: ${C.subtext}; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

        /* ── Responsive layout ── */
        .hero-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 60px;
          align-items: center;
          padding: 80px 48px 60px;
          max-width: 1100px;
          margin: 0 auto;
        }
        .brief-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 60px;
          align-items: center;
          padding: 80px 48px;
          max-width: 1100px;
          margin: 0 auto;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 24px;
          max-width: 900px;
          margin: 0 auto;
        }
        .blocked-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .features-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .section-pad { padding: 80px 48px; }
        .section-pad-alt { padding: 80px 48px; background: ${C.bgDeep}; border-top: 1px solid ${C.border}; border-bottom: 1px solid ${C.border}; }
        .nav-pad { padding: 14px 32px; }

        /* ── Mobile (≤ 640px) ── */
        @media (max-width: 640px) {
          .hero-grid {
            grid-template-columns: 1fr;
            gap: 32px;
            padding: 48px 20px 36px;
          }
          .brief-grid {
            grid-template-columns: 1fr;
            gap: 32px;
            padding: 56px 20px;
          }
          .brief-grid > div:first-child { order: 2; }
          .brief-grid > div:last-child  { order: 1; }
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
          }
          .blocked-grid {
            grid-template-columns: 1fr;
          }
          .features-grid {
            grid-template-columns: 1fr;
          }
          .section-pad     { padding: 56px 20px; }
          .section-pad-alt { padding: 56px 20px; background: ${C.bgDeep}; border-top: 1px solid ${C.border}; border-bottom: 1px solid ${C.border}; }
          .nav-pad { padding: 12px 20px; }
          .hero-btns { flex-direction: column; align-items: stretch !important; }
          .hero-btns button { text-align: center; }
          .cta-btns { flex-direction: column; align-items: center !important; }
          .hide-mobile { display: none !important; }
        }

        /* ── Tablet (641–900px) ── */
        @media (min-width: 641px) and (max-width: 900px) {
          .hero-grid {
            grid-template-columns: 1fr;
            gap: 40px;
            padding: 60px 32px 48px;
          }
          .brief-grid {
            grid-template-columns: 1fr;
            gap: 40px;
            padding: 64px 32px;
          }
          .brief-grid > div:first-child { order: 2; }
          .brief-grid > div:last-child  { order: 1; }
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
          .blocked-grid { grid-template-columns: 1fr 1fr; }
          .features-grid { grid-template-columns: 1fr 1fr; }
          .section-pad     { padding: 64px 32px; }
          .section-pad-alt { padding: 64px 32px; background: ${C.bgDeep}; border-top: 1px solid ${C.border}; border-bottom: 1px solid ${C.border}; }
          .nav-pad { padding: 14px 28px; }
        }
      `}</style>

      {/* ── Nav ── */}
      <nav style={{ borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center', position:'sticky', top:0, background:`${C.bg}ee`, backdropFilter:'blur(12px)', zIndex:100 }} className="nav-pad">
        <div style={{ fontFamily:SERIF, fontWeight:600, fontSize:22, color:C.green }}>Options Edge</div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button className="btn-secondary" style={{ padding:'8px 16px', fontSize:11 }} onClick={() => navigate('/sign-in')}>SIGN IN</button>
          <button className="btn-primary"   style={{ padding:'8px 16px', fontSize:11 }} onClick={() => navigate('/sign-up')}>FREE TRIAL</button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <div className="hero-grid">
        <div>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, border:`1px solid ${C.blue}30`, background:`${C.blue}08`, borderRadius:4, padding:'5px 14px', marginBottom:20 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:C.green, animation:'pulse 2s infinite' }} />
            <span style={{ fontFamily:MONO, fontSize:10, color:C.blue, letterSpacing:2 }}>LIVE OPTIONS SCANNER</span>
          </div>
          <h1 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(38px,7vw,58px)', lineHeight:1.15, marginBottom:18, color:C.text }}>
            Find the setup.<br />
            <span style={{ color:C.green }}>Skip the trap.</span>
          </h1>
          <p style={{ fontSize:15, color:C.subtext, lineHeight:1.8, marginBottom:12 }}>
            GEX-weighted options scanner that scores every contract on conviction, then automatically blocks the trades that look good but historically lose.
          </p>
          <p style={{ fontFamily:MONO, fontSize:12, color:C.dim, lineHeight:1.8, marginBottom:28 }}>
            Live Tradier data · Real bid/ask · 6 hard-block filters · AI morning brief
          </p>
          <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:18 }} className="hero-btns">
            <button className="btn-primary"   onClick={() => navigate('/sign-up')}>START FREE TRIAL →</button>
            <button className="btn-secondary" onClick={() => navigate('/sign-in')}>SIGN IN</button>
          </div>
          <div style={{ fontFamily:MONO, fontSize:10, color:C.dim, lineHeight:2 }}>
            ✓ 7-day free trial &nbsp;·&nbsp; ✓ No credit card to start &nbsp;·&nbsp; ✓ Cancel anytime
          </div>
        </div>
        <div>
          <ScannerMockup C={C} />
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div style={{ borderTop:`1px solid ${C.border}`, borderBottom:`1px solid ${C.border}`, background:C.bgDeep, padding:'28px 20px' }}>
        <div className="stats-grid">
          {[
            { value:'8',   label:'Symbols Scanned',  suffix:'' },
            { value:'6',   label:'Hard-Block Filters',suffix:'' },
            { value:'21',  label:'Ideal DTE Window',  suffix:'–35' },
            { value:'$19', label:'Per Month',         suffix:'' },
          ].map((s,i) => (
            <div key={i} style={{ textAlign:'center' }}>
              <div style={{ fontFamily:SERIF, fontWeight:600, fontSize:34, color:C.green, lineHeight:1 }}>
                {s.value}<span style={{ fontSize:20, color:C.blue }}>{s.suffix}</span>
              </div>
              <div style={{ fontFamily:MONO, fontSize:9, color:C.dim, letterSpacing:1, marginTop:4 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Morning Brief ── */}
      <div className="brief-grid">
        <div>
          <BriefMockup C={C} />
        </div>
        <div>
          <div style={{ fontFamily:MONO, fontSize:10, color:C.orange, letterSpacing:2, marginBottom:14 }}>EVERY MORNING · 8 AM CT</div>
          <h2 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(26px,4.5vw,40px)', color:C.text, lineHeight:1.2, marginBottom:16 }}>
            Know the market<br />before you trade it.<br /><span style={{ color:C.orange }}></span>
          </h2>
          <p style={{ fontSize:14, color:C.subtext, lineHeight:1.8, marginBottom:14 }}>
            Every trading day at 8 AM CT, an AI-generated market brief lands in your app. Bias, key levels, today's catalysts, and the one risk trigger that would flip everything.
          </p>
          <p style={{ fontFamily:MONO, fontSize:12, color:C.dim, lineHeight:1.8 }}>
            Built from live S&P 500, VIX, DXY, crude oil, and BTC data.
          </p>
        </div>
      </div>

      {/* ── Why trades fail ── */}
      <div className="section-pad-alt">
        <div style={{ maxWidth:920, margin:'0 auto' }}>
          <div style={{ textAlign:'center', marginBottom:40 }}>
            <div style={{ fontFamily:MONO, fontSize:10, color:C.red, letterSpacing:2, marginBottom:12 }}>THE PROBLEM WE SOLVE</div>
            <h2 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(24px,4vw,38px)', color:C.text, marginBottom:10 }}>Why most options trades lose</h2>
            <p style={{ fontFamily:MONO, fontSize:12, color:C.dim }}>Real trade patterns our filters block every session</p>
          </div>
          <div className="blocked-grid">
            {[
              { ticker:'$MSTR', setup:'Long Call $170C · IV 66%',  tag:'🚨 BLOCKED', reason:'Chasing +3.94% move',    detail:"Stock already moved 4%. You're buying premium that already priced in the move. Entry blocked at 9:31 AM." },
              { ticker:'$GOOGL',setup:'Long Call $400C · BE +4.3%', tag:'⚠️ BLOCKED', reason:'No catalyst identified', detail:'Break-even requires +4.3% in 22 days with no earnings, no catalyst. Historically bottom-quartile win rate.' },
              { ticker:'$AMZN', setup:'Long Put $182P · DTE 3',    tag:'🚨 BLOCKED', reason:'DTE crush risk',          detail:'3 DTE with theta burn before catalyst. Premium decay kills the position before the move happens.' },
            ].map((ex,i) => (
              <div key={i} style={{ background:C.card, border:`1px solid ${C.red}30`, borderRadius:8, padding:'18px 20px', boxShadow:C.shadow }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                  <div>
                    <div style={{ fontFamily:SERIF, fontWeight:600, fontSize:18, color:C.text }}>{ex.ticker}</div>
                    <div style={{ fontFamily:MONO, fontSize:10, color:C.dim, marginTop:2 }}>{ex.setup}</div>
                  </div>
                  <div style={{ fontFamily:MONO, fontSize:9, color:C.red, background:`${C.red}15`, border:`1px solid ${C.red}30`, borderRadius:3, padding:'3px 8px', whiteSpace:'nowrap', marginLeft:8 }}>{ex.tag}</div>
                </div>
                <div style={{ fontFamily:MONO, fontSize:10, color:C.red, marginBottom:8 }}>↳ {ex.reason}</div>
                <div style={{ fontSize:12, color:C.subtext, lineHeight:1.7 }}>{ex.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Features ── */}
      <div className="section-pad" style={{ maxWidth:1100, margin:'0 auto' }}>
        <div style={{ textAlign:'center', marginBottom:40 }}>
          <div style={{ fontFamily:MONO, fontSize:10, color:C.blue, letterSpacing:2, marginBottom:12 }}>EVERYTHING IN ONE PLACE</div>
          <h2 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(24px,4vw,38px)', color:C.text }}>Built for serious traders</h2>
        </div>
        <div className="features-grid">
          {getFeatures(C).map((f,i) => (
            <div key={i} className="feature-card">
              <div style={{ fontSize:28, marginBottom:12 }}>{f.icon}</div>
              <div style={{ fontFamily:SERIF, fontWeight:600, fontSize:16, color:f.color, marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:13, color:C.subtext, lineHeight:1.8 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Pricing ── */}
      <div className="section-pad-alt">
        <div style={{ maxWidth:760, margin:'0 auto' }}>
          <div style={{ textAlign:'center', marginBottom:40 }}>
            <div style={{ fontFamily:MONO, fontSize:10, color:C.green, letterSpacing:2, marginBottom:12 }}>PRICING</div>
            <h2 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(24px,4vw,38px)', color:C.text, marginBottom:8 }}>Simple. One plan.</h2>
            <p style={{ fontFamily:MONO, fontSize:12, color:C.dim }}>Everything included. No feature gating. No upsells.</p>
          </div>
          <div style={{ maxWidth:420, margin:'0 auto', background:C.card, border:`1px solid ${C.green}40`, borderRadius:12, padding:'36px 28px', position:'relative', boxShadow:C.shadowLg }}>
            <div style={{ position:'absolute', top:-13, left:'50%', transform:'translateX(-50%)', background:C.green, color:isDark?'#1c1916':'#ffffff', fontFamily:SANS, fontWeight:700, fontSize:11, letterSpacing:1, padding:'4px 16px', borderRadius:4, whiteSpace:'nowrap' }}>7-DAY FREE TRIAL</div>
            <div style={{ fontFamily:SERIF, fontWeight:600, fontSize:24, color:C.green, marginBottom:4 }}>Pro</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:24 }}>
              <span style={{ fontFamily:SERIF, fontWeight:600, fontSize:46, color:C.text, lineHeight:1 }}>$19</span>
              <span style={{ fontFamily:MONO, fontSize:13, color:C.dim }}>/month</span>
            </div>
            <div style={{ marginBottom:24 }}>
              {[
                'Live options scanner — real Tradier data',
                'GEX + OI + Volume conviction scoring',
                'All 6 hard-block filters active',
                'SPX / NDX index setups',
                'Auto-scanner across full watchlist',
                'Morning AI readout — daily brief',
                'Email + SMS push alerts',
                'Unlimited trade journal + backtest',
                'Structure intelligence',
              ].map((f,i) => (
                <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', padding:'6px 0', borderBottom:`1px solid ${C.borderDim}`, fontFamily:MONO, fontSize:11, color:C.subtext }}>
                  <span style={{ color:C.green, flexShrink:0 }}>✓</span>{f}
                </div>
              ))}
            </div>
            <button className="btn-primary" onClick={() => navigate('/sign-up')} style={{ width:'100%', padding:'15px', fontSize:14, textAlign:'center' }}>START FREE TRIAL →</button>
            <div style={{ fontFamily:MONO, fontSize:10, color:C.dim, textAlign:'center', marginTop:12, lineHeight:1.8 }}>No charge for 7 days · Cancel anytime · Secured by Stripe</div>
          </div>
        </div>
      </div>

      {/* ── FAQ ── */}
      <div style={{ maxWidth:700, margin:'0 auto' }} className="section-pad">
        <div style={{ textAlign:'center', marginBottom:36 }}>
          <h2 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(22px,4vw,34px)', color:C.text }}>Questions</h2>
        </div>
        {FAQS.map((f,i) => (
          <div key={i} style={{ borderBottom:`1px solid ${C.border}`, overflow:'hidden' }}>
            <button onClick={() => setOpenFaq(openFaq===i ? null : i)} style={{ width:'100%', background:'transparent', border:'none', padding:'18px 0', display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer', gap:16 }}>
              <span style={{ fontFamily:SANS, fontSize:14, color:C.text, textAlign:'left', fontWeight:500, lineHeight:1.5 }}>{f.q}</span>
              <span style={{ color:C.green, fontSize:20, flexShrink:0, transition:'transform 0.2s', transform: openFaq===i ? 'rotate(45deg)' : 'rotate(0)' }}>+</span>
            </button>
            {openFaq===i && (
              <div style={{ fontFamily:SANS, fontSize:13, color:C.subtext, lineHeight:1.8, paddingBottom:18, paddingRight:32 }}>{f.a}</div>
            )}
          </div>
        ))}
      </div>

      {/* ── Final CTA ── */}
      <div className="section-pad-alt" style={{ textAlign:'center' }}>
        <div style={{ maxWidth:600, margin:'0 auto' }}>
          <div style={{ fontFamily:MONO, fontSize:10, color:C.green, letterSpacing:2, marginBottom:16 }}>READY TO TRADE SMARTER?</div>
          <h2 style={{ fontFamily:SERIF, fontWeight:600, fontSize:'clamp(28px,5.5vw,48px)', color:C.text, lineHeight:1.15, marginBottom:18 }}>
            Stop guessing.<br /><span style={{ color:C.green }}>Start scoring.</span>
          </h2>
          <p style={{ fontFamily:SANS, fontSize:14, color:C.subtext, lineHeight:1.8, marginBottom:28 }}>
            7-day free trial. Full access from day one. No credit card required to start.
          </p>
          <div style={{ display:'flex', gap:12, justifyContent:'center', flexWrap:'wrap' }} className="cta-btns">
            <button className="btn-primary" onClick={() => navigate('/sign-up')} style={{ padding:'16px 48px', fontSize:15 }}>START FREE TRIAL →</button>
          </div>
          <div style={{ fontFamily:MONO, fontSize:10, color:C.dim, marginTop:16 }}>$19/month after trial · Cancel anytime</div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ borderTop:`1px solid ${C.border}`, padding:'24px 20px', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
        <div style={{ fontFamily:SERIF, fontWeight:600, fontSize:16, color:C.dim }}>Options Edge</div>
        <div style={{ fontFamily:MONO, fontSize:9, color:C.dim, lineHeight:1.8, textAlign:'center', flex:1 }}>
          Not financial advice · Options trading involves substantial risk of loss
        </div>
        <a href="mailto:support@optionsedgeflow.com" style={{ fontFamily:MONO, fontSize:10, color:C.dim }}>SUPPORT</a>
      </div>
    </div>
  )
}
