import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const BB   = "'Bebas Neue', Impact, sans-serif"
const MONO = "'IBM Plex Mono', 'Courier New', monospace"
const SANS = "'Inter', system-ui, sans-serif"

// ── Mock scanner data ─────────────────────────────────────────────────────────
const MOCK_ALERTS = [
  { symbol:'SPY',  type:'CALL', strike:545, dte:21, score:88, mid:3.42, grade:'A', color:'#00ff88' },
  { symbol:'NVDA', type:'CALL', strike:135, dte:28, score:82, mid:4.15, grade:'A', color:'#00ff88' },
  { symbol:'QQQ',  type:'PUT',  strike:455, dte:14, score:76, mid:2.88, grade:'B', color:'#00c8ff' },
  { symbol:'TSLA', type:'CALL', strike:265, dte:35, score:71, mid:5.60, grade:'B', color:'#00c8ff' },
  { symbol:'AAPL', type:'CALL', strike:215, dte:21, score:68, mid:2.10, grade:'B', color:'#00c8ff' },
]

const FEATURES = [
  { icon:'⚡', title:'Conviction Scoring',    desc:'Every contract scored 0–100 using GEX, delta, IV, liquidity, and direction. Only high-conviction setups make it through.', color:'#00ff88' },
  { icon:'🛡', title:'6 Hard-Block Filters',  desc:'Kills chasing trades, IV traps, morning noise, DTE crush, and no-catalyst setups automatically before you see them.', color:'#00c8ff' },
  { icon:'📊', title:'Morning AI Readout',    desc:'Daily pre-market brief with market bias, key levels, and risk triggers. Generated fresh every morning from live data.', color:'#ff9500' },
  { icon:'📈', title:'Structure Intelligence',desc:'Recommends naked, spread, condor, or butterfly based on IV environment and directional conviction.', color:'#00ff88' },
  { icon:'📋', title:'Trade Journal',         desc:'Log trades with one tap. Track win rate by conviction band, IV level, and strategy over time.', color:'#00c8ff' },
  { icon:'🔔', title:'Email & SMS Alerts',    desc:'Push notifications the moment a high-conviction setup hits your threshold.', color:'#ff9500' },
]

const FAQS = [
  { q:'Do I need a brokerage account?',         a:'No. Options Edge provides trade ideas and analytics. You execute through your own broker — TD Ameritrade, IBKR, Tastytrade, etc.' },
  { q:'Where does the market data come from?',  a:'Live options chain data via Tradier API — real bid/ask, Greeks, open interest, and volume on every scan.' },
  { q:'What happens after the free trial?',     a:"You're charged $29/month after 7 days. Cancel anytime before then and you won't be charged. Your journal data is always preserved." },
  { q:'Is this financial advice?',              a:'No. Options Edge is an analytical tool. All setups are generated algorithmically. You are solely responsible for your trading decisions.' },
  { q:'What makes this different from a screener?', a:"Screeners show you what moved. Options Edge scores why a specific contract makes sense right now — then blocks the trades that look good but historically lose." },
]

// ── Animated scanner mockup ───────────────────────────────────────────────────
function ScannerMockup() {
  const [active, setActive] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)

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
    <div style={{ background:'#060c14', border:'1px solid #1a2e3e', borderRadius:10, overflow:'hidden', fontFamily:MONO, fontSize:11, boxShadow:'0 24px 64px rgba(0,255,136,0.08), 0 8px 24px rgba(0,0,0,0.6)' }}>
      {/* Title bar */}
      <div style={{ background:'#0a1520', borderBottom:'1px solid #1a2e3e', padding:'10px 14px', display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#ff5f57' }} />
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#febc2e' }} />
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#28c840' }} />
        <span style={{ marginLeft:8, color:'#2a4a5a', fontSize:10, letterSpacing:1 }}>OPTIONS EDGE — AUTO SCANNER</span>
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background: scanning ? '#ff9500' : '#00ff88', boxShadow: scanning ? '0 0 6px #ff9500' : '0 0 6px #00ff88' }} />
          <span style={{ color: scanning ? '#ff9500' : '#00ff88', fontSize:9, letterSpacing:1 }}>{scanning ? 'SCANNING' : 'LIVE'}</span>
        </div>
      </div>
      {scanning && (
        <div style={{ height:2, background:'#0a1520' }}>
          <div style={{ height:'100%', background:'linear-gradient(90deg,#00ff88,#00c8ff)', width:progress+'%', transition:'width 0.08s linear' }} />
        </div>
      )}
      {/* Watchlist pills */}
      <div style={{ padding:'8px 14px', borderBottom:'1px solid #0d1e2a', display:'flex', gap:5, flexWrap:'wrap' }}>
        {['SPY','QQQ','NVDA','TSLA','AAPL','META','AMZN','IWM'].map(s => (
          <span key={s} style={{ fontSize:9, color: s===alert.symbol ? '#00ff88' : '#2a4a5a', background: s===alert.symbol ? '#00ff8815' : 'transparent', border:'1px solid '+(s===alert.symbol ? '#00ff8840' : '#0d1e2a'), borderRadius:3, padding:'2px 6px', transition:'all 0.3s' }}>{s}</span>
        ))}
        <span style={{ marginLeft:'auto', fontSize:9, color:'#2a4a5a' }}>SWING 21–45D</span>
      </div>
      {/* Column headers */}
      <div style={{ padding:'5px 14px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid #0d1e2a' }}>
        {['SYMBOL','CONTRACT','DTE','CONVICTION','GRD','MID'].map((h,i) => (
          <span key={i} style={{ fontSize:8, color:'#2a4a5a', letterSpacing:1, flex: h==='CONVICTION'?1:'none', width: h==='SYMBOL'?36:h==='CONTRACT'?68:h==='DTE'?24:h==='GRD'?22:36 }}>{h}</span>
        ))}
      </div>
      {/* Rows */}
      <div style={{ padding:'4px 0' }}>
        {MOCK_ALERTS.map((a, i) => (
          <div key={i} style={{ padding:'7px 14px', display:'flex', alignItems:'center', gap:8, background: i===active ? '#0a1e14' : 'transparent', borderLeft:'2px solid '+(i===active ? a.color : 'transparent'), transition:'all 0.4s', opacity: i===active ? 1 : 0.3 }}>
            <span style={{ color:a.color, fontWeight:700, width:36, fontSize:12 }}>{a.symbol}</span>
            <span style={{ color:'#c8d8e8', width:68, fontSize:10 }}>{a.type} {a.strike}</span>
            <span style={{ color:'#4a7a8a', width:24, fontSize:10 }}>{a.dte}D</span>
            <div style={{ flex:1, display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ flex:1, height:3, background:'#0d1e2a', borderRadius:2, overflow:'hidden' }}>
                <div style={{ height:'100%', width: i===active ? a.score+'%' : '0%', background:'linear-gradient(90deg,'+a.color+'80,'+a.color+')', transition:'width 0.6s ease', borderRadius:2 }} />
              </div>
              <span style={{ color:a.color, fontWeight:700, width:22, textAlign:'right', fontSize:10 }}>{a.score}</span>
            </div>
            <div style={{ background:a.color+'20', border:'1px solid '+a.color+'50', borderRadius:3, padding:'1px 5px', color:a.color, fontWeight:700, fontSize:10, width:22, textAlign:'center' }}>{a.grade}</div>
            <span style={{ color:'#c8d8e8', width:36, textAlign:'right', fontSize:10 }}>${a.mid}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop:'1px solid #0d1e2a', padding:'7px 14px', display:'flex', justifyContent:'space-between', color:'#1a3040', fontSize:8, letterSpacing:1 }}>
        <span>TRADIER LIVE DATA</span>
        <span>GEX + OI + VOLUME</span>
        <span>NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  )
}

// ── Morning Brief mockup ──────────────────────────────────────────────────────
function BriefMockup() {
  return (
    <div style={{ background:'#0d1a26', border:'1px solid #1a2e3e', borderRadius:8, overflow:'hidden', fontFamily:MONO, fontSize:11 }}>
      <div style={{ background:'#0a1520', borderBottom:'1px solid #1a2e3e', padding:'10px 14px', display:'flex', justifyContent:'space-between' }}>
        <span style={{ color:'#c8d8e8', fontWeight:700, letterSpacing:1.5, fontSize:10 }}>📊 MORNING READOUT</span>
        <span style={{ color:'#4a7a8a', fontSize:9 }}>08:42 CT</span>
      </div>
      <div style={{ padding:14 }}>
        <div style={{ background:'#00ff8812', border:'1px solid #00ff8830', borderRadius:6, padding:'10px 12px', marginBottom:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
            <span style={{ color:'#00ff88', fontSize:16, fontWeight:900 }}>▲</span>
            <span style={{ color:'#00ff88', fontFamily:BB, fontSize:18, letterSpacing:2 }}>BULLISH</span>
            <span style={{ color:'#4a7a8a', fontSize:9, marginLeft:'auto' }}>Risk-on / Tech-led</span>
          </div>
          <div style={{ color:'#c8d8e8', fontSize:11, lineHeight:1.6 }}>Fed hold confirmed. Tech earnings beat driving broad risk appetite into the session.</div>
        </div>
        <div style={{ background:'#ff446610', border:'1px solid #ff446630', borderRadius:6, padding:'8px 12px', display:'flex', gap:8, alignItems:'flex-start' }}>
          <span style={{ color:'#ff6688', fontSize:9, fontWeight:700, flexShrink:0 }}>⚡ RISK TRIGGER</span>
          <span style={{ color:'#c8d8e8', fontSize:10, lineHeight:1.5, marginLeft:4 }}>Hot CPI or hawkish Fed speaker reverses rally</span>
        </div>
      </div>
    </div>
  )
}

// ── Main Landing ──────────────────────────────────────────────────────────────
export default function Landing() {
  const navigate = useNavigate()
  const [openFaq, setOpenFaq] = useState(null)

  return (
    <div style={{ background:'#090e14', color:'#c8d8e8', fontFamily:SANS, minHeight:'100vh', overflowX:'hidden' }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
        a { color: inherit; text-decoration: none }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-thumb { background: #1a3040 }

        .btn-primary {
          background: #00ff8820; border: 1px solid #00ff88; color: #00ff88;
          padding: 14px 28px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: ${BB}; letter-spacing: 2px; transition: all 0.2s; white-space: nowrap;
          -webkit-tap-highlight-color: transparent;
        }
        .btn-primary:hover, .btn-primary:active { background: #00ff8835; }
        .btn-secondary {
          background: transparent; border: 1px solid #1a2e3e; color: #4a7a8a;
          padding: 14px 24px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: ${BB}; letter-spacing: 2px; transition: all 0.2s;
          -webkit-tap-highlight-color: transparent;
        }
        .btn-secondary:hover, .btn-secondary:active { border-color: #2a4a5a; color: #6a9aaa; }
        .feature-card {
          background: #0d1a26; border: 1px solid #1a2e3e; border-radius: 8px;
          padding: 22px; transition: border-color 0.2s;
        }
        .feature-card:hover { border-color: #2a4a5a; }
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
        .section-pad-alt { padding: 80px 48px; background: #04080e; border-top: 1px solid #1a2e3e; border-bottom: 1px solid #1a2e3e; }
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
          .section-pad-alt { padding: 56px 20px; background: #04080e; border-top: 1px solid #1a2e3e; border-bottom: 1px solid #1a2e3e; }
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
          .section-pad-alt { padding: 64px 32px; background: #04080e; border-top: 1px solid #1a2e3e; border-bottom: 1px solid #1a2e3e; }
          .nav-pad { padding: 14px 28px; }
        }
      `}</style>

      {/* ── Nav ── */}
      <nav style={{ borderBottom:'1px solid #1a2e3e', display:'flex', justifyContent:'space-between', alignItems:'center', position:'sticky', top:0, background:'#090e14ee', backdropFilter:'blur(12px)', zIndex:100 }} className="nav-pad">
        <div style={{ fontFamily:BB, fontSize:22, letterSpacing:3, color:'#00ff88' }}>OPTIONS EDGE</div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button className="btn-secondary" style={{ padding:'8px 16px', fontSize:11 }} onClick={() => navigate('/sign-in')}>SIGN IN</button>
          <button className="btn-primary"   style={{ padding:'8px 16px', fontSize:11 }} onClick={() => navigate('/sign-up')}>FREE TRIAL</button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <div className="hero-grid">
        <div>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, border:'1px solid #00c8ff30', background:'#00c8ff08', borderRadius:4, padding:'5px 14px', marginBottom:20 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'#00ff88', animation:'pulse 2s infinite' }} />
            <span style={{ fontFamily:MONO, fontSize:10, color:'#00c8ff', letterSpacing:2 }}>LIVE OPTIONS SCANNER</span>
          </div>
          <h1 style={{ fontFamily:BB, fontSize:'clamp(42px,8vw,68px)', lineHeight:1.0, letterSpacing:3, marginBottom:18, color:'#c8d8e8' }}>
            FIND THE<br />SETUP.<br />
            <span style={{ color:'#00ff88' }}>SKIP THE<br />TRAP.</span>
          </h1>
          <p style={{ fontSize:15, color:'#6a9aaa', lineHeight:1.8, marginBottom:12 }}>
            GEX-weighted options scanner that scores every contract on conviction, then automatically blocks the trades that look good but historically lose.
          </p>
          <p style={{ fontFamily:MONO, fontSize:12, color:'#4a7a8a', lineHeight:1.8, marginBottom:28 }}>
            Live Tradier data · Real bid/ask · 6 hard-block filters · AI morning brief
          </p>
          <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:18 }} className="hero-btns">
            <button className="btn-primary"   onClick={() => navigate('/sign-up')}>START FREE TRIAL →</button>
            <button className="btn-secondary" onClick={() => navigate('/sign-in')}>SIGN IN</button>
          </div>
          <div style={{ fontFamily:MONO, fontSize:10, color:'#2a4a5a', lineHeight:2 }}>
            ✓ 7-day free trial &nbsp;·&nbsp; ✓ No credit card to start &nbsp;·&nbsp; ✓ Cancel anytime
          </div>
        </div>
        <div>
          <ScannerMockup />
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div style={{ borderTop:'1px solid #1a2e3e', borderBottom:'1px solid #1a2e3e', background:'#04080e', padding:'28px 20px' }}>
        <div className="stats-grid">
          {[
            { value:'8',   label:'Symbols Scanned',  suffix:'' },
            { value:'6',   label:'Hard-Block Filters',suffix:'' },
            { value:'21',  label:'Ideal DTE Window',  suffix:'–35' },
            { value:'$29', label:'Per Month',         suffix:'' },
          ].map((s,i) => (
            <div key={i} style={{ textAlign:'center' }}>
              <div style={{ fontFamily:BB, fontSize:38, color:'#00ff88', letterSpacing:2, lineHeight:1 }}>
                {s.value}<span style={{ fontSize:22, color:'#00c8ff' }}>{s.suffix}</span>
              </div>
              <div style={{ fontFamily:MONO, fontSize:9, color:'#4a7a8a', letterSpacing:1, marginTop:4 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Morning Brief ── */}
      <div className="brief-grid">
        <div>
          <BriefMockup />
        </div>
        <div>
          <div style={{ fontFamily:MONO, fontSize:10, color:'#ff9500', letterSpacing:2, marginBottom:14 }}>EVERY MORNING · 8 AM CT</div>
          <h2 style={{ fontFamily:BB, fontSize:'clamp(28px,5vw,48px)', color:'#c8d8e8', letterSpacing:3, lineHeight:1.1, marginBottom:16 }}>
            KNOW THE MARKET<br />BEFORE YOU<br /><span style={{ color:'#ff9500' }}>TRADE IT</span>
          </h2>
          <p style={{ fontSize:14, color:'#6a9aaa', lineHeight:1.8, marginBottom:14 }}>
            Every trading day at 8 AM CT, an AI-generated market brief lands in your app. Bias, key levels, today's catalysts, and the one risk trigger that would flip everything.
          </p>
          <p style={{ fontFamily:MONO, fontSize:12, color:'#4a7a8a', lineHeight:1.8 }}>
            Built from live S&P 500, VIX, DXY, crude oil, and BTC data.
          </p>
        </div>
      </div>

      {/* ── Why trades fail ── */}
      <div className="section-pad-alt">
        <div style={{ maxWidth:920, margin:'0 auto' }}>
          <div style={{ textAlign:'center', marginBottom:40 }}>
            <div style={{ fontFamily:MONO, fontSize:10, color:'#ff4466', letterSpacing:2, marginBottom:12 }}>THE PROBLEM WE SOLVE</div>
            <h2 style={{ fontFamily:BB, fontSize:'clamp(26px,4vw,44px)', color:'#c8d8e8', letterSpacing:3, marginBottom:10 }}>WHY MOST OPTIONS TRADES LOSE</h2>
            <p style={{ fontFamily:MONO, fontSize:12, color:'#4a7a8a' }}>Real trade patterns our filters block every session</p>
          </div>
          <div className="blocked-grid">
            {[
              { ticker:'$MSTR', setup:'Long Call $170C · IV 66%',  tag:'🚨 BLOCKED', reason:'Chasing +3.94% move',    detail:"Stock already moved 4%. You're buying premium that already priced in the move. Entry blocked at 9:31 AM." },
              { ticker:'$GOOGL',setup:'Long Call $400C · BE +4.3%', tag:'⚠️ BLOCKED', reason:'No catalyst identified', detail:'Break-even requires +4.3% in 22 days with no earnings, no catalyst. Historically bottom-quartile win rate.' },
              { ticker:'$AMZN', setup:'Long Put $182P · DTE 3',    tag:'🚨 BLOCKED', reason:'DTE crush risk',          detail:'3 DTE with theta burn before catalyst. Premium decay kills the position before the move happens.' },
            ].map((ex,i) => (
              <div key={i} style={{ background:'#0d1a26', border:'1px solid #ff446630', borderRadius:8, padding:'18px 20px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                  <div>
                    <div style={{ fontFamily:BB, fontSize:20, color:'#c8d8e8', letterSpacing:2 }}>{ex.ticker}</div>
                    <div style={{ fontFamily:MONO, fontSize:10, color:'#4a7a8a', marginTop:2 }}>{ex.setup}</div>
                  </div>
                  <div style={{ fontFamily:MONO, fontSize:9, color:'#ff4466', background:'#ff446615', border:'1px solid #ff446630', borderRadius:3, padding:'3px 8px', whiteSpace:'nowrap', marginLeft:8 }}>{ex.tag}</div>
                </div>
                <div style={{ fontFamily:MONO, fontSize:10, color:'#ff6688', marginBottom:8 }}>↳ {ex.reason}</div>
                <div style={{ fontSize:12, color:'#4a7a8a', lineHeight:1.7 }}>{ex.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Features ── */}
      <div className="section-pad" style={{ maxWidth:1100, margin:'0 auto' }}>
        <div style={{ textAlign:'center', marginBottom:40 }}>
          <div style={{ fontFamily:MONO, fontSize:10, color:'#00c8ff', letterSpacing:2, marginBottom:12 }}>EVERYTHING IN ONE PLACE</div>
          <h2 style={{ fontFamily:BB, fontSize:'clamp(26px,4vw,44px)', color:'#c8d8e8', letterSpacing:3 }}>BUILT FOR SERIOUS TRADERS</h2>
        </div>
        <div className="features-grid">
          {FEATURES.map((f,i) => (
            <div key={i} className="feature-card">
              <div style={{ fontSize:28, marginBottom:12 }}>{f.icon}</div>
              <div style={{ fontFamily:BB, fontSize:17, color:f.color, letterSpacing:1.5, marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:13, color:'#4a7a8a', lineHeight:1.8 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Pricing ── */}
      <div className="section-pad-alt">
        <div style={{ maxWidth:760, margin:'0 auto' }}>
          <div style={{ textAlign:'center', marginBottom:40 }}>
            <div style={{ fontFamily:MONO, fontSize:10, color:'#00ff88', letterSpacing:2, marginBottom:12 }}>PRICING</div>
            <h2 style={{ fontFamily:BB, fontSize:'clamp(26px,4vw,44px)', color:'#c8d8e8', letterSpacing:3, marginBottom:8 }}>SIMPLE. ONE PLAN.</h2>
            <p style={{ fontFamily:MONO, fontSize:12, color:'#4a7a8a' }}>Everything included. No feature gating. No upsells.</p>
          </div>
          <div style={{ maxWidth:420, margin:'0 auto', background:'#060e06', border:'1px solid #00ff8840', borderRadius:12, padding:'36px 28px', position:'relative', boxShadow:'0 0 60px #00ff8810' }}>
            <div style={{ position:'absolute', top:-13, left:'50%', transform:'translateX(-50%)', background:'#00ff88', color:'#000', fontFamily:BB, fontSize:11, letterSpacing:2, padding:'4px 16px', borderRadius:4, whiteSpace:'nowrap' }}>7-DAY FREE TRIAL</div>
            <div style={{ fontFamily:BB, fontSize:28, color:'#00ff88', letterSpacing:3, marginBottom:4 }}>PRO</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:24 }}>
              <span style={{ fontFamily:BB, fontSize:52, color:'#c8d8e8', lineHeight:1 }}>$29</span>
              <span style={{ fontFamily:MONO, fontSize:13, color:'#4a7a8a' }}>/month</span>
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
                <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', padding:'6px 0', borderBottom:'1px solid #0d1e14', fontFamily:MONO, fontSize:11, color:'#8ab0c0' }}>
                  <span style={{ color:'#00ff88', flexShrink:0 }}>✓</span>{f}
                </div>
              ))}
            </div>
            <button className="btn-primary" onClick={() => navigate('/sign-up')} style={{ width:'100%', padding:'15px', fontSize:14, textAlign:'center' }}>START FREE TRIAL →</button>
            <div style={{ fontFamily:MONO, fontSize:10, color:'#2a4a5a', textAlign:'center', marginTop:12, lineHeight:1.8 }}>No charge for 7 days · Cancel anytime · Secured by Stripe</div>
          </div>
        </div>
      </div>

      {/* ── FAQ ── */}
      <div style={{ maxWidth:700, margin:'0 auto' }} className="section-pad">
        <div style={{ textAlign:'center', marginBottom:36 }}>
          <h2 style={{ fontFamily:BB, fontSize:'clamp(24px,4vw,40px)', color:'#c8d8e8', letterSpacing:3 }}>QUESTIONS</h2>
        </div>
        {FAQS.map((f,i) => (
          <div key={i} style={{ borderBottom:'1px solid #1a2e3e', overflow:'hidden' }}>
            <button onClick={() => setOpenFaq(openFaq===i ? null : i)} style={{ width:'100%', background:'transparent', border:'none', padding:'18px 0', display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer', gap:16 }}>
              <span style={{ fontFamily:SANS, fontSize:14, color:'#c8d8e8', textAlign:'left', fontWeight:500, lineHeight:1.5 }}>{f.q}</span>
              <span style={{ color:'#00ff88', fontSize:20, flexShrink:0, transition:'transform 0.2s', transform: openFaq===i ? 'rotate(45deg)' : 'rotate(0)' }}>+</span>
            </button>
            {openFaq===i && (
              <div style={{ fontFamily:SANS, fontSize:13, color:'#4a7a8a', lineHeight:1.8, paddingBottom:18, paddingRight:32 }}>{f.a}</div>
            )}
          </div>
        ))}
      </div>

      {/* ── Final CTA ── */}
      <div className="section-pad-alt" style={{ textAlign:'center' }}>
        <div style={{ maxWidth:600, margin:'0 auto' }}>
          <div style={{ fontFamily:MONO, fontSize:10, color:'#00ff88', letterSpacing:2, marginBottom:16 }}>READY TO TRADE SMARTER?</div>
          <h2 style={{ fontFamily:BB, fontSize:'clamp(30px,6vw,56px)', color:'#c8d8e8', letterSpacing:3, lineHeight:1.05, marginBottom:18 }}>
            STOP GUESSING.<br /><span style={{ color:'#00ff88' }}>START SCORING.</span>
          </h2>
          <p style={{ fontFamily:SANS, fontSize:14, color:'#4a7a8a', lineHeight:1.8, marginBottom:28 }}>
            7-day free trial. Full access from day one. No credit card required to start.
          </p>
          <div style={{ display:'flex', gap:12, justifyContent:'center', flexWrap:'wrap' }} className="cta-btns">
            <button className="btn-primary" onClick={() => navigate('/sign-up')} style={{ padding:'16px 48px', fontSize:15 }}>START FREE TRIAL →</button>
          </div>
          <div style={{ fontFamily:MONO, fontSize:10, color:'#1a3040', marginTop:16 }}>$29/month after trial · Cancel anytime</div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ borderTop:'1px solid #1a2e3e', padding:'24px 20px', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
        <div style={{ fontFamily:BB, fontSize:18, letterSpacing:3, color:'#2a4a5a' }}>OPTIONS EDGE</div>
        <div style={{ fontFamily:MONO, fontSize:9, color:'#1a3040', lineHeight:1.8, textAlign:'center', flex:1 }}>
          Not financial advice · Options trading involves substantial risk of loss
        </div>
        <a href="mailto:support@optionsedgeflow.com" style={{ fontFamily:MONO, fontSize:10, color:'#2a4a5a' }}>SUPPORT</a>
      </div>
    </div>
  )
}
