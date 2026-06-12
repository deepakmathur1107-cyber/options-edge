import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const BB = "'Bebas Neue', Impact, sans-serif"
const MONO = "'IBM Plex Mono', 'Courier New', monospace"
const SANS = "'Inter', system-ui, sans-serif"

// ── Mock scan log — matches real app terminal style ──────────────────────────
const SCAN_LOG = [
  { time:'09:47:12 AM', sym:'$NVDA', score:86, type:'Long Call', strike:'$135C', mid:'$4.15', grade:'A', color:'#00ff88' },
  { time:'09:47:09 AM', sym:'$SPY',  score:88, type:'Long Call', strike:'$545C', mid:'$3.42', grade:'A', color:'#00ff88' },
  { time:'09:47:05 AM', sym:'$QQQ',  score:76, type:'Long Put',  strike:'$455P', mid:'$2.88', grade:'B', color:'#00c8ff' },
  { time:'09:47:01 AM', sym:'$TSLA', score:71, type:'Long Call', strike:'$265C', mid:'$5.60', grade:'B', color:'#00c8ff' },
  { time:'09:46:58 AM', sym:'$AAPL', score:68, type:'Long Call', strike:'$215C', mid:'$2.10', grade:'B', color:'#00c8ff' },
  { time:'09:46:54 AM', sym:'$META', score:52, type:'Long Call', strike:'$590C', mid:'$6.80', grade:'C', color:'#ff9500' },
]
const STATUS_LINES = [
  { time:'09:47:00 AM', text:'▶ Scanning 342 tickers · Swing Trade (21–45 DTE)', blue:true },
  { time:'09:47:00 AM', text:'▶ Started · Swing Trade', blue:true },
  { time:'09:47:00 AM', text:'DTE window: Swing (21-45 DTE) · every 15 min · 90%+ threshold', blue:false },
]

// ── Scanner mockup — terminal style matching real app ─────────────────────────
function ScannerMockup() {
  const [logs, setLogs] = useState([SCAN_LOG[0]])
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)
  const idxRef = useRef(1)

  useEffect(() => {
    const cycle = setInterval(() => {
      setScanning(true)
      setProgress(0)
      let p = 0
      const prog = setInterval(() => {
        p += 14
        setProgress(Math.min(p, 100))
        if (p >= 100) {
          clearInterval(prog)
          setScanning(false)
          const next = SCAN_LOG[idxRef.current % SCAN_LOG.length]
          setLogs(prev => [next, ...prev].slice(0, 6))
          idxRef.current++
        }
      }, 60)
    }, 2800)
    return () => clearInterval(cycle)
  }, [])

  return (
    <div style={{ background:'#0a0f14', border:'1px solid #1a2e3e', borderRadius:10, overflow:'hidden', fontFamily:MONO, fontSize:11, boxShadow:'0 24px 64px rgba(0,255,136,0.06), 0 8px 24px rgba(0,0,0,0.6)' }}>

      {/* Title bar */}
      <div style={{ background:'#060c12', borderBottom:'1px solid #1a2e3e', padding:'10px 14px', display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#ff5f57' }} />
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#febc2e' }} />
        <div style={{ width:10, height:10, borderRadius:'50%', background:'#28c840' }} />
        <span style={{ marginLeft:8, color:'#2a4a5a', fontSize:10, letterSpacing:1 }}>OPTIONS EDGE — AUTO SCANNER</span>
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background: scanning ? '#ff9500' : '#00ff88', boxShadow: scanning ? '0 0 6px #ff9500' : '0 0 6px #00ff88' }} />
          <span style={{ color: scanning ? '#ff9500' : '#00ff88', fontSize:9, letterSpacing:1 }}>{scanning ? 'SCANNING...' : '● ACTIVE'}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height:2, background:'#060c12' }}>
        <div style={{ height:'100%', background:'linear-gradient(90deg,#00ff88,#00c8ff)', width: scanning ? progress+'%' : '100%', transition:'width 0.06s linear', opacity: scanning ? 1 : 0.15 }} />
      </div>

      {/* Controls */}
      <div style={{ padding:'10px 14px', borderBottom:'1px solid #0d1a24', display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:9, color:'#2a4a5a', marginBottom:5, letterSpacing:1 }}>MIN EDGE SCORE</div>
          <div style={{ position:'relative', height:4, background:'#0d1a24', borderRadius:2 }}>
            <div style={{ position:'absolute', left:0, top:0, height:'100%', width:'90%', background:'linear-gradient(90deg,#1a6a3a,#00ff88)', borderRadius:2 }} />
            <div style={{ position:'absolute', top:'50%', left:'90%', transform:'translate(-50%,-50%)', width:12, height:12, borderRadius:'50%', background:'#00ff88', boxShadow:'0 0 6px #00ff88' }} />
          </div>
        </div>
        <div style={{ fontFamily:MONO, fontSize:11, color:'#00ff88', fontWeight:700 }}>90%+</div>
        <div style={{ background:'#ff446620', border:'1px solid #ff446660', borderRadius:4, padding:'4px 10px', fontSize:9, color:'#ff4466', letterSpacing:1 }}>■ STOP</div>
      </div>

      {/* Scan log */}
      <div style={{ minHeight:180 }}>
        <div style={{ padding:'6px 14px', fontSize:9, color:'#2a4a5a', letterSpacing:1, borderBottom:'1px solid #0d1a24' }}>SCAN LOG</div>
        {logs.map((entry, i) => (
          <div key={i} style={{ padding:'5px 14px', display:'flex', alignItems:'center', gap:8, background: i===0 ? '#0a1e14' : 'transparent', borderLeft:'2px solid '+(i===0 ? entry.color : 'transparent'), transition:'all 0.3s', opacity: Math.max(0.2, 1 - i*0.18) }}>
            <span style={{ color:'#2a4a5a', fontSize:9, flexShrink:0 }}>[{entry.time}]</span>
            <span style={{ color:entry.color, fontWeight:700, width:40 }}>{entry.sym}</span>
            <span style={{ color:'#c8d8e8' }}>{entry.score}%</span>
            <span style={{ color:'#4a7a8a' }}>{entry.type}</span>
            <span style={{ color:'#c8d8e8' }}>{entry.strike}</span>
            <span style={{ color:'#4a7a8a', fontSize:9 }}>mid</span>
            <span style={{ color:'#c8d8e8' }}>{entry.mid}</span>
            <div style={{ marginLeft:'auto', background:entry.color+'20', border:'1px solid '+entry.color+'50', borderRadius:3, padding:'1px 6px', color:entry.color, fontWeight:700, fontSize:10 }}>{entry.grade}</div>
          </div>
        ))}
        <div style={{ borderTop:'1px solid #0d1a24', marginTop:4 }}>
          {STATUS_LINES.map((s,i) => (
            <div key={i} style={{ padding:'3px 14px', fontSize:9, color: s.blue ? '#00c8ff' : '#2a4a5a', opacity:0.7 }}>[{s.time}] {s.text}</div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop:'1px solid #0d1a24', padding:'7px 14px', display:'flex', justifyContent:'space-between', color:'#1a3040', fontSize:9, letterSpacing:1 }}>
        <span>TRADIER LIVE DATA · REAL BID/ASK</span>
        <span>GEX + OI + VOLUME SCORING</span>
        <span>NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  )
}

const FEATURES = [
  {
    icon: '⚡',
    title: 'Conviction-Scored Alerts',
    desc: 'Every setup gets a 0–100 score built from GEX, delta quality, IV environment, liquidity, and directional alignment. Only high-conviction trades make it through.',
    color: '#00ff88',
  },
  {
    icon: '🛡',
    title: '6 Hard-Block Filters',
    desc: 'Automatically kills chasing trades, IV traps, morning noise, DTE crush, and no-catalyst setups — the exact patterns that drain accounts.',
    color: '#00c8ff',
  },
  {
    icon: '📊',
    title: 'Morning AI Readout',
    desc: 'Daily pre-market brief with market bias, key levels, risk triggers, and today\'s catalysts. Generated fresh every morning from live market data.',
    color: '#ff9500',
  },
  {
    icon: '📈',
    title: 'Structure Intelligence',
    desc: 'Recommends the right structure for each setup — naked, spread, condor, butterfly — based on IV environment and directional conviction.',
    color: '#00ff88',
  },
  {
    icon: '📋',
    title: 'Trade Journal & Backtest',
    desc: 'Log every trade with one tap. Track win rate by conviction band, IV level, and strategy. See exactly where your edge is — and where it isn\'t.',
    color: '#00c8ff',
  },
  {
    icon: '🔔',
    title: 'Email & SMS Alerts',
    desc: 'Push notifications the moment a high-conviction setup hits your threshold. Never miss a setup because you weren\'t watching.',
    color: '#ff9500',
  },
]

const STATS = [
  { value: '8', label: 'Symbols scanned', suffix: '' },
  { value: '6', label: 'Hard-block filters', suffix: '' },
  { value: '21', label: 'Ideal DTE window', suffix: '-35' },
  { value: '$29', label: 'Per month', suffix: '' },
]

const FAQS = [
  { q: 'Do I need a brokerage account?', a: 'No. Options Edge provides trade ideas and analytics. You execute through your own broker — TD Ameritrade, IBKR, Tastytrade, etc.' },
  { q: 'Where does the market data come from?', a: 'Live options chain data via Tradier API — real bid/ask, Greeks, open interest, and volume on every scan.' },
  { q: 'What happens after the free trial?', a: 'You\'re charged $29/month after 7 days. Cancel anytime before then and you won\'t be charged. Your journal data is always preserved.' },
  { q: 'Is this financial advice?', a: 'No. Options Edge is an analytical tool. All setups are generated algorithmically. You are solely responsible for your trading decisions.' },
  { q: 'What makes this different from a screener?', a: 'Screeners show you what moved. Options Edge scores why a specific contract makes sense right now — accounting for structure, IV, liquidity, direction, and risk — then blocks the trades that look good but historically lose.' },
]

  const alert = MOCK_ALERTS[active]

  return (
    <div style={{ background: '#060c14', border: '1px solid #1a2e3e', borderRadius: 10, overflow: 'hidden', fontFamily: MONO, fontSize: 11, boxShadow: '0 24px 64px rgba(0,255,136,0.08), 0 8px 24px rgba(0,0,0,0.6)' }}>

      {/* Window chrome */}
      <div style={{ background: '#0a1520', borderBottom: '1px solid #1a2e3e', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840' }} />
        <span style={{ marginLeft: 8, color: '#2a4a5a', fontSize: 10, letterSpacing: 1 }}>OPTIONS EDGE — AUTO SCANNER</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: scanning ? '#ff9500' : '#00ff88', boxShadow: scanning ? '0 0 6px #ff9500' : '0 0 6px #00ff88' }} />
          <span style={{ color: scanning ? '#ff9500' : '#00ff88', fontSize: 9, letterSpacing: 1 }}>{scanning ? 'SCANNING' : 'LIVE'}</span>
        </div>
      </div>

      {/* Scanner progress bar */}
      {scanning && (
        <div style={{ height: 2, background: '#0a1520' }}>
          <div style={{ height: '100%', background: 'linear-gradient(90deg, #00ff88, #00c8ff)', width: `${progress}%`, transition: 'width 0.08s linear' }} />
        </div>
      )}

      {/* Watchlist row */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #0d1e2a', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {['SPY','QQQ','NVDA','TSLA','AAPL','META','AMZN','IWM'].map(s => (
          <span key={s} style={{ fontSize: 9, color: s === alert.symbol ? '#00ff88' : '#2a4a5a', background: s === alert.symbol ? '#00ff8815' : 'transparent', border: `1px solid ${s === alert.symbol ? '#00ff8840' : '#0d1e2a'}`, borderRadius: 3, padding: '2px 6px', transition: 'all 0.3s' }}>{s}</span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 9, color: '#2a4a5a' }}>SWING (21–45 DTE)</span>
      </div>

      {/* Alert rows */}
      <div style={{ padding: '8px 0' }}>
        {MOCK_ALERTS.map((a, i) => (
          <div key={i} style={{
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: i === active ? '#0a1e14' : 'transparent',
            borderLeft: `2px solid ${i === active ? a.color : 'transparent'}`,
            transition: 'all 0.4s',
            opacity: i === active ? 1 : 0.35,
          }}>
            <span style={{ color: a.color, fontWeight: 700, width: 36, fontSize: 12 }}>{a.symbol}</span>
            <span style={{ color: '#c8d8e8', width: 70 }}>{a.type} {a.strike}</span>
            <span style={{ color: '#4a7a8a', width: 50 }}>{a.dte}DTE</span>
            <span style={{ color: '#4a7a8a', width: 36 }}>{a.iv}</span>
            {/* Score bar */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, height: 3, background: '#0d1e2a', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: i === active ? `${a.score}%` : '0%', background: `linear-gradient(90deg, ${a.color}80, ${a.color})`, transition: 'width 0.6s ease', borderRadius: 2 }} />
              </div>
              <span style={{ color: a.color, fontWeight: 700, width: 22, textAlign: 'right' }}>{a.score}</span>
            </div>
            <div style={{ background: `${a.color}20`, border: `1px solid ${a.color}50`, borderRadius: 3, padding: '1px 7px', color: a.color, fontWeight: 700, fontSize: 12, width: 22, textAlign: 'center' }}>{a.grade}</div>
            <span style={{ color: '#c8d8e8', width: 36, textAlign: 'right' }}>${a.mid}</span>
          </div>
        ))}
      </div>

      {/* Bottom bar */}
      <div style={{ borderTop: '1px solid #0d1e2a', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', color: '#2a4a5a', fontSize: 9, letterSpacing: 1 }}>
        <span>TRADIER LIVE DATA · REAL BID/ASK</span>
        <span>GEX + OI + VOLUME SCORING</span>
        <span>NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  )
}

// ── Morning Brief mockup ──────────────────────────────────────────────────────
function BriefMockup() {
  return (
    <div style={{ background: '#0d1a26', border: '1px solid #1a2e3e', borderRadius: 8, overflow: 'hidden', fontFamily: MONO, fontSize: 11 }}>
      <div style={{ background: '#0a1520', borderBottom: '1px solid #1a2e3e', padding: '10px 14px', display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: '#c8d8e8', fontWeight: 700, letterSpacing: 1.5 }}>📊 MORNING READOUT</span>
        <span style={{ color: '#4a7a8a', fontSize: 9 }}>08:42 CT</span>
      </div>
      <div style={{ padding: 14 }}>
        <div style={{ background: '#00ff8812', border: '1px solid #00ff8830', borderRadius: 6, padding: '10px 12px', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ color: '#00ff88', fontSize: 16, fontWeight: 900 }}>▲</span>
            <span style={{ color: '#00ff88', fontFamily: BB, fontSize: 18, letterSpacing: 2 }}>BULLISH</span>
            <span style={{ color: '#4a7a8a', fontSize: 9, marginLeft: 'auto' }}>Risk-on / Tech-led / Momentum</span>
          </div>
          <div style={{ color: '#c8d8e8', fontSize: 11, lineHeight: 1.6 }}>Fed hold confirmed. Tech earnings beat driving broad risk appetite into the session.</div>
        </div>
        <div style={{ background: '#ff446610', border: '1px solid #ff446630', borderRadius: 6, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ color: '#ff6688', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>⚡ RISK TRIGGER</span>
          <span style={{ color: '#c8d8e8', fontSize: 10, lineHeight: 1.5, marginLeft: 4 }}>CPI print above 3.5% or hawkish Fed speaker reverses rally</span>
        </div>
      </div>
    </div>
  )
}

// ── Main Landing component ────────────────────────────────────────────────────
export default function Landing() {
  const navigate = useNavigate()
  const [openFaq, setOpenFaq] = useState(null)

  return (
    <div style={{ background: '#090e14', color: '#c8d8e8', fontFamily: SANS, minHeight: '100vh', overflowX: 'hidden' }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0 }
        a { color: inherit; text-decoration: none }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-thumb { background: #1a3040 }
        .btn-primary {
          background: #00ff8820; border: 1px solid #00ff88; color: #00ff88;
          padding: 14px 32px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: ${BB}; letter-spacing: 2px; transition: all 0.2s;
          white-space: nowrap;
        }
        .btn-primary:hover { background: #00ff8835; box-shadow: 0 0 24px #00ff8825; }
        .btn-secondary {
          background: transparent; border: 1px solid #1a2e3e; color: #4a7a8a;
          padding: 14px 28px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: ${BB}; letter-spacing: 2px; transition: all 0.2s;
        }
        .btn-secondary:hover { border-color: #2a4a5a; color: #6a9aaa; }
        .feature-card {
          background: #0d1a26; border: 1px solid #1a2e3e; border-radius: 8px;
          padding: 24px; transition: all 0.2s;
        }
        .feature-card:hover { border-color: #2a4a5a; transform: translateY(-2px); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        .fade-up { animation: fadeUp 0.6s ease forwards; }
      `}</style>

      {/* ── Sticky Nav ─────────────────────────────────────────────────────── */}
      <nav style={{ borderBottom: '1px solid #1a2e3e', padding: '14px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: '#090e14ee', backdropFilter: 'blur(12px)', zIndex: 100 }}>
        <div style={{ fontFamily: BB, fontSize: 22, letterSpacing: 3, color: '#00ff88' }}>OPTIONS EDGE</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn-secondary" style={{ padding: '8px 18px', fontSize: 11 }} onClick={() => navigate('/sign-in')}>SIGN IN</button>
          <button className="btn-primary" style={{ padding: '8px 18px', fontSize: 11 }} onClick={() => navigate('/sign-up')}>START FREE TRIAL</button>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '80px 32px 60px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 60, alignItems: 'center' }}>
        {/* Left — copy */}
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid #00c8ff30', background: '#00c8ff08', borderRadius: 4, padding: '5px 14px', marginBottom: 20 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00ff88', animation: 'pulse 2s infinite' }} />
            <span style={{ fontFamily: MONO, fontSize: 10, color: '#00c8ff', letterSpacing: 2 }}>LIVE OPTIONS SCANNER</span>
          </div>

          <h1 style={{ fontFamily: BB, fontSize: 'clamp(44px,5vw,68px)', lineHeight: 1.0, letterSpacing: 3, marginBottom: 20, color: '#c8d8e8' }}>
            FIND THE<br />
            SETUP.<br />
            <span style={{ color: '#00ff88' }}>SKIP THE</span><br />
            <span style={{ color: '#00ff88' }}>TRAP.</span>
          </h1>

          <p style={{ fontSize: 15, color: '#6a9aaa', lineHeight: 1.8, marginBottom: 12, fontFamily: SANS }}>
            GEX-weighted options scanner that scores every contract on conviction, then automatically blocks the trades that look good but historically lose.
          </p>
          <p style={{ fontSize: 13, color: '#4a7a8a', lineHeight: 1.8, marginBottom: 32, fontFamily: MONO }}>
            Live Tradier data · Real bid/ask · Hard-block filters · AI morning brief
          </p>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <button className="btn-primary" onClick={() => navigate('/sign-up')}>START FREE TRIAL →</button>
            <button className="btn-secondary" onClick={() => navigate('/sign-in')}>SIGN IN</button>
          </div>

          <div style={{ fontFamily: MONO, fontSize: 10, color: '#2a4a5a', lineHeight: 2 }}>
            ✓ 7-day free trial &nbsp;·&nbsp; ✓ No credit card to start &nbsp;·&nbsp; ✓ Cancel anytime
          </div>
        </div>

        {/* Right — live scanner mockup */}
        <div>
          <ScannerMockup />
        </div>
      </div>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid #1a2e3e', borderBottom: '1px solid #1a2e3e', background: '#04080e', padding: '28px 32px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
          {STATS.map((s, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: BB, fontSize: 40, color: '#00ff88', letterSpacing: 2, lineHeight: 1 }}>
                {s.value}<span style={{ fontSize: 24, color: '#00c8ff' }}>{s.suffix}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#4a7a8a', letterSpacing: 1, marginTop: 4 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Morning Brief section ──────────────────────────────────────────── */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '80px 32px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 60, alignItems: 'center' }}>
        <div>
          <BriefMockup />
        </div>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#ff9500', letterSpacing: 2, marginBottom: 14 }}>EVERY MORNING · 8 AM CT</div>
          <h2 style={{ fontFamily: BB, fontSize: 'clamp(30px,4vw,48px)', color: '#c8d8e8', letterSpacing: 3, lineHeight: 1.1, marginBottom: 18 }}>
            KNOW THE<br />MARKET BEFORE<br /><span style={{ color: '#ff9500' }}>YOU TRADE IT</span>
          </h2>
          <p style={{ fontSize: 14, color: '#6a9aaa', lineHeight: 1.8, marginBottom: 16 }}>
            Every trading day at 8 AM CT, an AI-generated market brief lands in your app. Bias, key levels, today's catalysts, and the one risk trigger that would flip everything.
          </p>
          <p style={{ fontSize: 13, color: '#4a7a8a', lineHeight: 1.8, fontFamily: MONO }}>
            Built from live S&P 500, VIX, DXY, crude oil, and BTC data. Not recycled news — fresh analysis every session.
          </p>
        </div>
      </div>

      {/* ── Why trades fail ────────────────────────────────────────────────── */}
      <div style={{ background: '#04080e', borderTop: '1px solid #1a2e3e', borderBottom: '1px solid #1a2e3e', padding: '80px 32px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: '#ff4466', letterSpacing: 2, marginBottom: 12 }}>THE PROBLEM WE SOLVE</div>
            <h2 style={{ fontFamily: BB, fontSize: 'clamp(28px,4vw,44px)', color: '#c8d8e8', letterSpacing: 3, marginBottom: 12 }}>
              WHY MOST OPTIONS TRADES LOSE
            </h2>
            <p style={{ fontSize: 13, color: '#4a7a8a', fontFamily: MONO, maxWidth: 500, margin: '0 auto' }}>
              These are real trade patterns our filters block every session
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            {[
              { ticker: '$MSTR', setup: 'Long Call $170C · IV 66%', tag: '🚨 BLOCKED', reason: 'Chasing +3.94% move', detail: 'Stock already moved 4%. You\'re buying premium that already priced in the move. Entry blocked at 9:31 AM.' },
              { ticker: '$GOOGL', setup: 'Long Call $400C · BE +4.3%', tag: '⚠️ BLOCKED', reason: 'No catalyst identified', detail: 'Break-even requires +4.3% in 22 days with no earnings, no catalyst. Historically bottom-quartile win rate.' },
              { ticker: '$AMZN', setup: 'Long Put $182P · DTE 3', tag: '🚨 BLOCKED', reason: 'DTE crush risk', detail: '3 DTE with 2 days of theta burn before catalyst. Premium decay kills the position before the move happens.' },
            ].map((ex, i) => (
              <div key={i} style={{ background: '#0d1a26', border: '1px solid #ff446630', borderRadius: 8, padding: '18px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontFamily: BB, fontSize: 20, color: '#c8d8e8', letterSpacing: 2 }}>{ex.ticker}</div>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: '#4a7a8a', marginTop: 2 }}>{ex.setup}</div>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: '#ff4466', background: '#ff446615', border: '1px solid #ff446630', borderRadius: 3, padding: '3px 8px', whiteSpace: 'nowrap' }}>{ex.tag}</div>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: '#ff6688', marginBottom: 8 }}>↳ {ex.reason}</div>
                <div style={{ fontSize: 11, color: '#4a7a8a', lineHeight: 1.7 }}>{ex.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Features grid ──────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '80px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#00c8ff', letterSpacing: 2, marginBottom: 12 }}>EVERYTHING IN ONE PLACE</div>
          <h2 style={{ fontFamily: BB, fontSize: 'clamp(28px,4vw,44px)', color: '#c8d8e8', letterSpacing: 3 }}>BUILT FOR SERIOUS TRADERS</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          {FEATURES.map((f, i) => (
            <div key={i} className="feature-card">
              <div style={{ fontSize: 28, marginBottom: 14 }}>{f.icon}</div>
              <div style={{ fontFamily: BB, fontSize: 17, color: f.color, letterSpacing: 1.5, marginBottom: 10 }}>{f.title}</div>
              <div style={{ fontSize: 13, color: '#4a7a8a', lineHeight: 1.8 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Pricing ────────────────────────────────────────────────────────── */}
      <div style={{ background: '#04080e', borderTop: '1px solid #1a2e3e', borderBottom: '1px solid #1a2e3e', padding: '80px 32px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: '#00ff88', letterSpacing: 2, marginBottom: 12 }}>PRICING</div>
            <h2 style={{ fontFamily: BB, fontSize: 'clamp(28px,4vw,44px)', color: '#c8d8e8', letterSpacing: 3, marginBottom: 10 }}>SIMPLE. ONE PLAN.</h2>
            <p style={{ fontFamily: MONO, fontSize: 12, color: '#4a7a8a' }}>Everything included. No feature gating. No upsells.</p>
          </div>

          <div style={{ maxWidth: 400, margin: '0 auto', background: '#060e06', border: '1px solid #00ff8840', borderRadius: 12, padding: '36px 32px', position: 'relative', boxShadow: '0 0 60px #00ff8810' }}>
            <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: '#00ff88', color: '#000', fontFamily: BB, fontSize: 11, letterSpacing: 2, padding: '4px 16px', borderRadius: 4, whiteSpace: 'nowrap' }}>
              7-DAY FREE TRIAL
            </div>

            <div style={{ fontFamily: BB, fontSize: 28, color: '#00ff88', letterSpacing: 3, marginBottom: 4 }}>PRO</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 28 }}>
              <span style={{ fontFamily: BB, fontSize: 56, color: '#c8d8e8', lineHeight: 1 }}>$29</span>
              <span style={{ fontFamily: MONO, fontSize: 13, color: '#4a7a8a' }}>/month</span>
            </div>

            <div style={{ marginBottom: 28 }}>
              {[
                'Live options scanner — real Tradier data',
                'GEX + OI + Volume conviction scoring',
                'All 6 hard-block filters active',
                'SPX / NDX index setups',
                'Auto-scanner across full watchlist',
                'Morning AI readout — daily brief',
                'Email + SMS push alerts',
                'Unlimited trade journal + backtest',
                'Structure intelligence (spread/condor)',
              ].map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid #0d1e14', fontFamily: MONO, fontSize: 11, color: '#8ab0c0' }}>
                  <span style={{ color: '#00ff88', flexShrink: 0 }}>✓</span>
                  {f}
                </div>
              ))}
            </div>

            <button className="btn-primary" onClick={() => navigate('/sign-up')} style={{ width: '100%', padding: '15px', fontSize: 14, textAlign: 'center' }}>
              START FREE TRIAL →
            </button>
            <div style={{ fontFamily: MONO, fontSize: 10, color: '#2a4a5a', textAlign: 'center', marginTop: 12, lineHeight: 1.8 }}>
              No charge for 7 days · Cancel anytime · Secured by Stripe
            </div>
          </div>
        </div>
      </div>

      {/* ── FAQ ────────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '80px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h2 style={{ fontFamily: BB, fontSize: 'clamp(26px,4vw,40px)', color: '#c8d8e8', letterSpacing: 3 }}>QUESTIONS</h2>
        </div>
        {FAQS.map((f, i) => (
          <div key={i} style={{ borderBottom: '1px solid #1a2e3e', overflow: 'hidden' }}>
            <button
              onClick={() => setOpenFaq(openFaq === i ? null : i)}
              style={{ width: '100%', background: 'transparent', border: 'none', padding: '18px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 16 }}
            >
              <span style={{ fontFamily: SANS, fontSize: 14, color: '#c8d8e8', textAlign: 'left', fontWeight: 500 }}>{f.q}</span>
              <span style={{ color: '#00ff88', fontSize: 18, flexShrink: 0, transition: 'transform 0.2s', transform: openFaq === i ? 'rotate(45deg)' : 'rotate(0deg)' }}>+</span>
            </button>
            {openFaq === i && (
              <div style={{ fontFamily: SANS, fontSize: 13, color: '#4a7a8a', lineHeight: 1.8, paddingBottom: 18, paddingRight: 32 }}>{f.a}</div>
            )}
          </div>
        ))}
      </div>

      {/* ── Final CTA ──────────────────────────────────────────────────────── */}
      <div style={{ background: '#04080e', borderTop: '1px solid #1a2e3e', padding: '80px 32px', textAlign: 'center' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#00ff88', letterSpacing: 2, marginBottom: 16 }}>READY TO TRADE SMARTER?</div>
          <h2 style={{ fontFamily: BB, fontSize: 'clamp(32px,5vw,56px)', color: '#c8d8e8', letterSpacing: 3, lineHeight: 1.05, marginBottom: 20 }}>
            STOP GUESSING.<br /><span style={{ color: '#00ff88' }}>START SCORING.</span>
          </h2>
          <p style={{ fontFamily: SANS, fontSize: 14, color: '#4a7a8a', lineHeight: 1.8, marginBottom: 32 }}>
            7-day free trial. Full access from day one. No credit card required to start.
          </p>
          <button className="btn-primary" onClick={() => navigate('/sign-up')} style={{ padding: '16px 48px', fontSize: 15 }}>
            START FREE TRIAL →
          </button>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#1a3040', marginTop: 16 }}>
            $29/month after trial · Cancel anytime
          </div>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid #1a2e3e', padding: '28px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontFamily: BB, fontSize: 18, letterSpacing: 3, color: '#2a4a5a' }}>OPTIONS EDGE</div>
        <div style={{ fontFamily: MONO, fontSize: 9, color: '#1a3040', lineHeight: 1.8, textAlign: 'center' }}>
          Not financial advice · Options trading involves substantial risk of loss · Past performance does not guarantee future results
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <a href="mailto:support@optionsedgeflow.com" style={{ fontFamily: MONO, fontSize: 10, color: '#2a4a5a' }}>SUPPORT</a>
        </div>
      </div>
    </div>
  )
}
