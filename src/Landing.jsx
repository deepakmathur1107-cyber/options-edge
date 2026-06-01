import { useNavigate } from 'react-router-dom'

const F = 'IBM Plex Mono, monospace'
const BB = 'Bebas Neue, Georgia, serif'

const FEATURES = [
  { icon:'⌁', title:'GEX-Weighted Scanner',  desc:'Scores every strike using Open Interest, Volume, and Gamma Exposure — not just delta' },
  { icon:'◈', title:'SPX / NDX Index Alerts', desc:'Live SPX and NDX setups across all 4 timeframes with 90%+ conviction threshold' },
  { icon:'🛡', title:'6 Hard-Block Filters',   desc:'Blocks chasing, high IV traps, morning noise, DTE/IV crush, and no-catalyst trades automatically' },
  { icon:'📊', title:'Break-even Reality Check',desc:'Shows exactly how much the stock must move to profit before you enter a single trade' },
  { icon:'◎', title:'Backtest Analytics',      desc:'Win rate by conviction band, IV level, and break-even requirement — built from your own trade history' },
  { icon:'⚡', title:'Morning AI Readout',      desc:'Daily pre-market brief covering market direction, key levels, and economic calendar via Claude AI' },
  { icon:'📱', title:'Email + Telegram Alerts', desc:'Push alerts when conviction hits your threshold — never miss a setup' },
  { icon:'📋', title:'Trade Journal',           desc:'Log paper and real trades with one tap from any scan result. Track your edge over time.' },
]

const PLANS = [
  {
    name:'FREE', price:'$0', period:'forever',
    color:'#4a7a8a',
    features:['5 manual scans per day','Basic scoring (volume + delta)','10 trades in journal','—  No auto-scanner','—  No email alerts','—  No index setups','—  No backtest analytics'],
    cta:'Get Started Free', action:'free',
  },
  {
    name:'PRO', price:'$29', period:'/ month',
    color:'#00ff88', badge:'7-DAY FREE TRIAL',
    features:['Unlimited manual scans','GEX + OI + Volume strike scoring','Auto-scanner (full S&P 500)','SPX / NDX index alerts','Email + Telegram alerts','Morning AI readout','Unlimited journal + backtest','All 6 hard-block filters'],
    cta:'Start Free Trial', action:'pro', highlight:true,
  },
]

const FAQS = [
  { q:'Do I need a brokerage account?', a:'No. Options Edge provides trade ideas and analytics. You execute trades through your own broker (TD Ameritrade, IBKR, Tastytrade, etc.).' },
  { q:'Where does the market data come from?', a:'Live options chain data via Tradier API. You can use your own Tradier token (free) or leave it server-side.' },
  { q:'What happens if I cancel?', a:'Your access continues until the end of the current billing period. After that, you can still sign in but the app shows a subscription required screen. Your journal data is preserved.' },
  { q:'Is this financial advice?', a:'No. Options Edge is an analytical tool. All trade ideas are generated algorithmically. You are solely responsible for your trading decisions.' },
  { q:'Can I get a refund?', a:'Yes — if you are unsatisfied within 7 days of your first paid charge (after the free trial), contact us for a full refund.' },
]

export default function Landing() {
  const navigate = useNavigate()

  const handleCTA = (action) => {
    if (action === 'free' || action === 'pro') navigate('/sign-up')
  }

  return (
    <div style={{ background:'#090e14', color:'#c8d8e8', fontFamily:F, minHeight:'100vh' }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        .hv{cursor:pointer;transition:opacity .15s}.hv:hover{opacity:.8}
        a{color:inherit;text-decoration:none}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1a3040}
      `}</style>

      {/* ── Nav ── */}
      <nav style={{ borderBottom:'1px solid #1a2e3e', padding:'14px 24px', display:'flex', justifyContent:'space-between', alignItems:'center', position:'sticky', top:0, background:'#090e14', zIndex:100 }}>
        <div style={{ fontFamily:BB, fontSize:22, letterSpacing:3, color:'#00ff88' }}>OPTIONS EDGE</div>
        <div style={{ display:'flex', gap:10 }}>
          <button className="hv" onClick={()=>navigate('/sign-in')} style={{ background:'transparent', border:'1px solid #1a2e3e', color:'#4a7a8a', padding:'7px 16px', borderRadius:4, fontSize:11, cursor:'pointer', fontFamily:F }}>SIGN IN</button>
          <button className="hv" onClick={()=>navigate('/sign-up')} style={{ background:'#00ff8820', border:'1px solid #00ff88', color:'#00ff88', padding:'7px 16px', borderRadius:4, fontSize:11, cursor:'pointer', fontFamily:F }}>START FREE TRIAL</button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <div style={{ maxWidth:860, margin:'0 auto', padding:'72px 24px 56px', textAlign:'center' }}>
        <div style={{ fontSize:10, color:'#00c8ff', letterSpacing:3, marginBottom:16, border:'1px solid #00c8ff30', display:'inline-block', padding:'4px 14px', borderRadius:3 }}>REAL-TIME OPTIONS INTELLIGENCE</div>
        <h1 style={{ fontFamily:BB, fontSize:'clamp(38px,8vw,72px)', color:'#c8d8e8', letterSpacing:4, lineHeight:1.05, marginBottom:20 }}>
          FIND THE TRADE.<br/><span style={{ color:'#00ff88' }}>SKIP THE TRAP.</span>
        </h1>
        <p style={{ fontSize:13, color:'#6a9aaa', lineHeight:1.9, maxWidth:560, margin:'0 auto 32px' }}>
          GEX-weighted options scanner with hard-block filters that stop you from taking high-IV, 
          chasing, and no-catalyst trades — the exact setups that lose money.
        </p>
        <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
          <button className="hv" onClick={()=>navigate('/sign-up')} style={{ background:'#00ff8822', border:'1px solid #00ff88', color:'#00ff88', padding:'13px 32px', borderRadius:5, fontSize:13, cursor:'pointer', fontFamily:BB, letterSpacing:2 }}>START FREE TRIAL →</button>
          <button className="hv" onClick={()=>navigate('/sign-in')} style={{ background:'transparent', border:'1px solid #1a2e3e', color:'#4a7a8a', padding:'13px 28px', borderRadius:5, fontSize:13, cursor:'pointer', fontFamily:BB, letterSpacing:2 }}>SIGN IN</button>
        </div>
        <div style={{ fontSize:10, color:'#2a5060', marginTop:14 }}>7-day free trial · No credit card required to start · Cancel anytime</div>
      </div>

      {/* ── Features grid ── */}
      <div style={{ maxWidth:860, margin:'0 auto', padding:'0 24px 64px' }}>
        <div style={{ textAlign:'center', marginBottom:36 }}>
          <div style={{ fontFamily:BB, fontSize:28, letterSpacing:3, color:'#c8d8e8' }}>WHAT YOU GET</div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:12 }}>
          {FEATURES.map((f,i)=>(
            <div key={i} style={{ background:'#0d1a26', border:'1px solid #1a2e3e', borderRadius:6, padding:'16px 18px' }}>
              <div style={{ fontSize:20, marginBottom:8 }}>{f.icon}</div>
              <div style={{ fontFamily:BB, fontSize:14, color:'#c8d8e8', letterSpacing:1.5, marginBottom:6 }}>{f.title}</div>
              <div style={{ fontSize:11, color:'#4a7a8a', lineHeight:1.7 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Why trades fail section ── */}
      <div style={{ background:'#04080e', borderTop:'1px solid #1a2e3e', borderBottom:'1px solid #1a2e3e', padding:'48px 24px' }}>
        <div style={{ maxWidth:760, margin:'0 auto' }}>
          <div style={{ fontFamily:BB, fontSize:26, letterSpacing:3, color:'#c8d8e8', marginBottom:8, textAlign:'center' }}>WHY MOST OPTION TRADES LOSE</div>
          <div style={{ fontSize:11, color:'#4a7a8a', textAlign:'center', marginBottom:32 }}>Real examples from trades our system would have blocked</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {[
              { ticker:'$MSTR', type:'Long Call $170C', entry:'$5.53 mid · IV 66.1%', blocked:'🚨 Chasing +3.94% · 🔥 IV 66% HIGH', lesson:'Stock already moved 4%. IV at 66% means you\'re paying for a move that already happened. Both filters block this at 9:31 AM.' },
              { ticker:'$GOOGL', type:'Long Call $400C', entry:'$8.55 mid · IV 30.6%', blocked:'⚠️ No catalyst · BE +4.3% required', lesson:'IV was fine but no specific catalyst identified. Break-even required +4.3% move in 22 days — historically bottom-quartile probability.' },
            ].map((ex,i)=>(
              <div key={i} style={{ background:'#0d1a26', border:'1px solid #ff446640', borderRadius:6, padding:'14px 16px' }}>
                <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
                  <span style={{ fontFamily:BB, fontSize:18, color:'#c8d8e8', letterSpacing:2 }}>{ex.ticker}</span>
                  <span style={{ fontSize:10, color:'#4a7a8a' }}>{ex.type}</span>
                </div>
                <div style={{ fontSize:10, color:'#4a7a8a', marginBottom:8 }}>{ex.entry}</div>
                <div style={{ fontSize:10, color:'#ff4466', background:'#1a040840', borderRadius:3, padding:'5px 8px', marginBottom:8, lineHeight:1.6 }}>{ex.blocked}</div>
                <div style={{ fontSize:10, color:'#5a7a8a', lineHeight:1.7 }}>{ex.lesson}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Pricing ── */}
      <div style={{ maxWidth:700, margin:'0 auto', padding:'64px 24px' }}>
        <div style={{ textAlign:'center', marginBottom:40 }}>
          <div style={{ fontFamily:BB, fontSize:28, letterSpacing:3, color:'#c8d8e8', marginBottom:8 }}>SIMPLE PRICING</div>
          <div style={{ fontSize:11, color:'#4a7a8a' }}>Start free. Upgrade when you're ready.</div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          {PLANS.map((p,i)=>(
            <div key={i} style={{ background: p.highlight?'#030e06':'#0d1a26', border:`1px solid ${p.highlight?p.color+'60':'#1a2e3e'}`, borderRadius:8, padding:'24px 22px', position:'relative' }}>
              {p.badge&&<div style={{ position:'absolute', top:-11, left:'50%', transform:'translateX(-50%)', background:'#00ff88', color:'#000', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'3px 10px', borderRadius:3, whiteSpace:'nowrap' }}>{p.badge}</div>}
              <div style={{ fontFamily:BB, fontSize:22, color:p.color, letterSpacing:3, marginBottom:4 }}>{p.name}</div>
              <div style={{ display:'flex', alignItems:'baseline', gap:4, marginBottom:16 }}>
                <span style={{ fontFamily:BB, fontSize:38, color:'#c8d8e8' }}>{p.price}</span>
                <span style={{ fontSize:11, color:'#4a7a8a' }}>{p.period}</span>
              </div>
              <div style={{ marginBottom:20 }}>
                {p.features.map((f,j)=>(
                  <div key={j} style={{ fontSize:11, color: f.startsWith('—')?'#2a4a5a':'#8ab0c0', padding:'4px 0', borderBottom:'1px solid #0d1a26', lineHeight:1.5 }}>
                    {f.startsWith('—') ? f : <><span style={{ color:p.color }}>✓ </span>{f}</>}
                  </div>
                ))}
              </div>
              <button className="hv" onClick={()=>handleCTA(p.action)} style={{ width:'100%', padding:'11px', borderRadius:5, fontSize:12, cursor:'pointer', fontFamily:BB, letterSpacing:1.5, background: p.highlight?`${p.color}20`:'transparent', border:`1px solid ${p.color}`, color:p.color }}>
                {p.cta}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── FAQ ── */}
      <div style={{ background:'#04080e', borderTop:'1px solid #1a2e3e', padding:'48px 24px' }}>
        <div style={{ maxWidth:680, margin:'0 auto' }}>
          <div style={{ fontFamily:BB, fontSize:26, letterSpacing:3, color:'#c8d8e8', marginBottom:32, textAlign:'center' }}>FAQ</div>
          {FAQS.map((f,i)=>(
            <div key={i} style={{ borderBottom:'1px solid #1a2e3e', padding:'16px 0' }}>
              <div style={{ fontSize:12, color:'#00ff88', marginBottom:6, letterSpacing:.5 }}>{f.q}</div>
              <div style={{ fontSize:11, color:'#4a7a8a', lineHeight:1.8 }}>{f.a}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ borderTop:'1px solid #1a2e3e', padding:'24px', textAlign:'center' }}>
        <div style={{ fontFamily:BB, fontSize:16, letterSpacing:3, color:'#2a4a5a', marginBottom:6 }}>OPTIONS EDGE</div>
        <div style={{ fontSize:10, color:'#1a3040', lineHeight:1.8 }}>
          Not financial advice. Options trading involves substantial risk of loss.<br/>
          Past performance does not guarantee future results.
        </div>
      </div>
    </div>
  )
}
