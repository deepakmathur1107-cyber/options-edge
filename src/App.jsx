import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Safe localStorage helper (won't crash on SSR) ───────────────────────────
const ls = (key, fallback='') => {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

// ─── Theme ───────────────────────────────────────────────────────────────────
const C = {
  green:'#00ff88', blue:'#00c8ff', orange:'#ff9500',
  red:'#ff4466',   dim:'#4a7a8a',  card:'#0d1a26',
  bg:'#090e14',    border:'#1a2e3e',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const autoStep = p => p<25?.5:p<50?1:p<100?2:p<250?5:p<500?10:p<1000?20:50
const fmtP  = n => n==null?'—':'$'+parseFloat(n).toFixed(2)
const fmtPct= n => n==null?'—':(parseFloat(n)*100).toFixed(1)+'%'
const safe  = v => v==null?'—':typeof v==='object'?JSON.stringify(v):String(v)

// ─── Module-level constants (safe from SSR) ───────────────────────────────────
const TF_CONFIG = {
  'Quick (5–14 DTE)': {
    expiryIdx:0, strikePct:1.02, profitTarget:0.50, stopLoss:0.50,
    label:'Quick Play', badge:'⚡', color:C.green,
    desc:'5–14 DTE · Fast momentum plays · 50% profit target',
  },
  'Swing (21–45 DTE)': {
    expiryIdx:2, strikePct:1.02, profitTarget:0.80, stopLoss:0.50,
    label:'Swing Trade', badge:'📈', color:C.blue,
    desc:'21–45 DTE · Directional swing · 80% profit target',
  },
  'LEAP (90–180 DTE)': {
    expiryIdx:4, strikePct:1.05, profitTarget:1.00, stopLoss:0.40,
    label:'LEAP Option', badge:'🏔️', color:C.orange,
    desc:'90–180 DTE · Trend plays · 100% profit target',
  },
  'Deep LEAP (180–365 DTE)': {
    expiryIdx:6, strikePct:1.08, profitTarget:1.50, stopLoss:0.35,
    label:'Deep LEAP', badge:'🚀', color:C.red,
    desc:'180–365 DTE · Long conviction · 150% profit target',
  },
}

const FUT_SYMBOLS = {
  ES:  { name:'E-Mini S&P 500',    under:'SPY' },
  NQ:  { name:'E-Mini Nasdaq 100', under:'QQQ' },
  YM:  { name:'Dow Jones',         under:'DIA' },
  RTY: { name:'Russell 2000',      under:'IWM' },
  CL:  { name:'Crude Oil',         under:'USO' },
  GC:  { name:'Gold',              under:'GLD' },
}

const SP500 = [
  'NVDA','AAPL','MSFT','META','AMZN','GOOGL','TSLA',
  'JPM','GS','XOM','LLY','UNH','CAT','BA','AMD',
  'CRM','NFLX','V','COIN','PLTR',
]

const CHECKLIST = [
  {id:'trend',cat:'TA',   l:'Trend Direction Confirmed', d:'20/50/200 EMA alignment checked'},
  {id:'rsi',  cat:'TA',   l:'RSI Not Extreme',           d:'RSI between 30–70 or confirmed reversal'},
  {id:'vol',  cat:'TA',   l:'Volume Above Average',      d:'At least 1.2x the 20-day avg'},
  {id:'macd', cat:'TA',   l:'MACD Confirmation',         d:'Crossover in trade direction'},
  {id:'lvl',  cat:'TA',   l:'Key Level Identified',      d:'Clear S/R, trendline, or breakout'},
  {id:'flow', cat:'Flow', l:'Options Flow Checked',      d:'Unusual sweeps align with thesis'},
  {id:'oi',   cat:'Flow', l:'Open Interest at Strikes',  d:'High OI at your strikes = magnet zones'},
  {id:'iv',   cat:'Flow', l:'IV Rank Assessed',          d:'Buy low IV, sell high IV'},
  {id:'cat',  cat:'News', l:'Catalyst Identified',       d:'Know the WHY — earnings, news, macro'},
  {id:'time', cat:'News', l:'Catalyst Timing Clear',     d:'Event date vs expiry date checked'},
  {id:'size', cat:'Risk', l:'Position Sized Correctly',  d:'Max 2–5% of account per trade'},
  {id:'stop', cat:'Risk', l:'Stop Loss Defined',         d:'50% loss on debit, 2x on credit'},
  {id:'tgt',  cat:'Risk', l:'Profit Target Set',         d:'25–50% quick, 50–100% swings'},
  {id:'plan', cat:'Risk', l:'Exit Scenario Planned',     d:'What if it goes against you?'},
]

const CAT_COLOR = { TA:C.green, Flow:C.blue, News:C.orange, Risk:C.red }

const EXIT_RULES = [
  { type:'Quick Plays (0–14 DTE)', color:C.green, rules:[
    {tr:'Profit Target', a:'Close at 25–40% gain on premium'},
    {tr:'Stop Loss',     a:'Exit at 50% loss — no exceptions'},
    {tr:'Time Stop',     a:'Exit EOD if no movement in 2 sessions'},
    {tr:'Post-Catalyst', a:'Close immediately after news event'},
  ]},
  { type:'Swing Trades (21–45 DTE)', color:C.blue, rules:[
    {tr:'Profit Target', a:'Take 50% at first target, trail the rest'},
    {tr:'Stop Loss',     a:'50% loss on debit, 2x credit for shorts'},
    {tr:'Time Decay',    a:'Close all longs at 21 DTE'},
    {tr:'Level Break',   a:'Key level violated? Close immediately'},
  ]},
  { type:'Iron Condors / Strangles', color:C.orange, rules:[
    {tr:'Profit Target', a:'Close at 50% of max profit'},
    {tr:'Time Exit',     a:'Always close at 21 DTE'},
    {tr:'Strike Breach', a:'Adjust or close if price hits short strike'},
    {tr:'IV Spike',      a:'IV doubles? Close and reassess'},
  ]},
]

const TABS = [
  {e:'📋',l:'Strategy'}, {e:'✅',l:'Checklist'}, {e:'📡',l:'Alert'},
  {e:'🚪',l:'Exit Rules'}, {e:'📒',l:'Journal'}, {e:'🤖',l:'Scanner'},
  {e:'📈',l:'Futures'}, {e:'⚙️',l:'Settings'},
]

// ─── Shared UI components ─────────────────────────────────────────────────────
const iSt = {
  width:'100%', background:C.card, border:`1px solid ${C.border}`,
  borderRadius:4, color:'#c8d8e8', padding:'9px 12px',
  fontSize:12, fontFamily:'inherit',
}

function Field({ label, value, onChange, placeholder, options, rows, type='text' }) {
  return (
    <div>
      <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4,textTransform:'uppercase'}}>{label}</div>
      {options
        ? <select value={value} onChange={e=>onChange(e.target.value)} style={iSt}>
            {options.map(o=><option key={o.v||o} value={o.v||o}>{o.l||o}</option>)}
          </select>
        : rows
          ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{...iSt,resize:'vertical'}}/>
          : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={iSt}/>
      }
    </div>
  )
}

function Card({ color, children, style={} }) {
  return (
    <div style={{background:C.card, border:`1px solid ${color||C.border}`, borderRadius:6, padding:14, ...style}}>
      {children}
    </div>
  )
}

function Lbl({ children, color=C.dim }) {
  return <div style={{fontSize:9,color,letterSpacing:2,marginBottom:6,textTransform:'uppercase'}}>{children}</div>
}

function Pill({ label, active, color=C.green, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:'7px 14px', borderRadius:4, fontSize:11, letterSpacing:.8, cursor:'pointer',
      border:`1px solid ${active?color:C.border}`, color:active?color:C.dim,
      background:active?`${color}18`:'transparent',
    }}>{label}</button>
  )
}

// ─── Tradier API proxy ─────────────────────────────────────────────────────────
async function tradierGet(path, token, mode) {
  const res = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, {
    headers: { 'x-tradier-token': token, 'x-tradier-mode': mode },
  })
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${await res.text().catch(()=>'')}`)
  return res.json()
}

async function sendTelegram(message, token, chatId) {
  const res = await fetch('/api/telegram', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ message, token, chat_id: chatId }),
  })
  return res.json()
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── tab ──
  const [tab, setTab] = useState(0)

  // ── settings (safe localStorage init) ──
  const [tradierToken, setTradierToken] = useState(() => ls('tradierToken'))
  const [tradierMode,  setTradierMode]  = useState(() => ls('tradierMode','production'))
  const [tgToken,      setTgToken]      = useState(() => ls('tgToken'))
  const [tgChatId,     setTgChatId]     = useState(() => ls('tgChatId'))
  const [watchlist,    setWatchlist]    = useState(() => ls('watchlist','NVDA,AAPL,MSFT,SPY,TSLA'))
  const [minScore,     setMinScore]     = useState(() => Number(ls('minScore','80')))
  const [scanFreq,     setScanFreq]     = useState(() => Number(ls('scanFreq','5')))
  const [tgStatus,     setTgStatus]     = useState('')

  // persist settings
  useEffect(()=>{ try{localStorage.setItem('tradierToken',tradierToken)}catch{} },[tradierToken])
  useEffect(()=>{ try{localStorage.setItem('tradierMode', tradierMode)} catch{} },[tradierMode])
  useEffect(()=>{ try{localStorage.setItem('tgToken',     tgToken)}     catch{} },[tgToken])
  useEffect(()=>{ try{localStorage.setItem('tgChatId',    tgChatId)}    catch{} },[tgChatId])
  useEffect(()=>{ try{localStorage.setItem('watchlist',   watchlist)}   catch{} },[watchlist])
  useEffect(()=>{ try{localStorage.setItem('minScore',    String(minScore))} catch{} },[minScore])
  useEffect(()=>{ try{localStorage.setItem('scanFreq',    String(scanFreq))} catch{} },[scanFreq])

  // ── checklist ──
  const [checked, setChecked] = useState({})
  const clScore = Math.round(Object.values(checked).filter(Boolean).length / CHECKLIST.length * 100)
  const clColor = clScore>=80?C.green:clScore>=60?C.orange:C.red

  // ── alert builder ──
  const [alert, setAlert] = useState({
    type:'Call', ticker:'', expiry:'', strike:'', entry:'',
    target:'', stop:'', size:'1–2 contracts', thesis:'', catalyst:'', flow:'',
  })
  const [copied, setCopied] = useState(false)

  // ── journal ──
  const [trades,   setTrades]   = useState(() => { try { return JSON.parse(ls('trades','[]')) } catch { return [] } })
  const [showAdd,  setShowAdd]  = useState(false)
  const [jFilter,  setJFilter]  = useState('All')
  const [newTrade, setNewTrade] = useState({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:''})
  useEffect(()=>{ try{localStorage.setItem('trades',JSON.stringify(trades))}catch{} },[trades])

  const jStats = (() => {
    const closed = trades.filter(t=>t.status!=='Open')
    const wins   = closed.filter(t=>parseFloat(t.pnl)>0)
    const losses = closed.filter(t=>parseFloat(t.pnl)<0)
    return {
      pnl:   closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0),
      wr:    closed.length ? Math.round(wins.length/closed.length*100) : 0,
      aw:    wins.length   ? wins.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/wins.length : 0,
      al:    losses.length ? Math.abs(losses.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/losses.length) : 0,
      total: closed.length,
      open:  trades.filter(t=>t.status==='Open').length,
    }
  })()

  // ── scanner ──
  const [scanTicker, setScanTicker] = useState('')
  const [scanType,   setScanType]   = useState('Any')
  const [scanTF,     setScanTF]     = useState('Swing (21–45 DTE)')
  const [scanning,   setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanErr,    setScanErr]    = useState('')
  const [debugLog,   setDebugLog]   = useState([])

  // ── auto-scanner ──
  const [autoOn,      setAutoOn]      = useState(false)
  const [autoLog,     setAutoLog]     = useState([])
  const [lastAlert,   setLastAlert]   = useState(null)
  const [alertCopied, setAlertCopied] = useState(false)
  const autoRef = useRef(null)

  // ── futures ──
  const [futSym,     setFutSym]     = useState('ES')
  const [futData,    setFutData]    = useState(null)
  const [futLoading, setFutLoading] = useState(false)
  const [futErr,     setFutErr]     = useState('')

  // ─── Tradier helpers ──────────────────────────────────────────────────────
  const tGet = useCallback((path) => tradierGet(path, tradierToken, tradierMode), [tradierToken, tradierMode])

  const getQuote    = async t => { const d = await tGet(`/markets/quotes?symbols=${t}&greeks=false`); return d?.quotes?.quote||null }
  const getExpiries = async t => { const d = await tGet(`/markets/options/expirations?symbol=${t}&includeAllRoots=false`); return d?.expirations?.date||[] }
  const getChain    = async (t,e) => { const d = await tGet(`/markets/options/chains?symbol=${t}&expiration=${e}&greeks=true`); return d?.options?.option||[] }

  // ─── Single ticker scan ───────────────────────────────────────────────────
  const runScan = async () => {
    if (!scanTicker.trim()) return
    if (!tradierToken) { setScanErr('❌ Add your Tradier token in ⚙️ Settings first'); return }
    const log=[]; const dbg=m=>{log.push(m);setDebugLog([...log])}
    setScanning(true); setScanResult(null); setScanErr(''); setDebugLog([])
    const ticker = scanTicker.toUpperCase()
    try {
      dbg(`1. Fetching live quote for $${ticker}...`)
      const quote = await getQuote(ticker)
      if (!quote) throw new Error('No quote — check ticker and token')
      const price = parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')
      dbg(`   ✓ $${ticker} = $${price.toFixed(2)} | chg: ${parseFloat(quote.change_percentage||0).toFixed(2)}%`)

      dbg('2. Fetching expiry dates...')
      const expDates = await getExpiries(ticker)
      if (!expDates.length) throw new Error('No expiry dates found')
      const tfCfg = TF_CONFIG[scanTF] || TF_CONFIG['Swing (21–45 DTE)']
      const expiryRaw = expDates[Math.min(tfCfg.expiryIdx, expDates.length-1)]
      const expiryDisplay = new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      dbg(`   ✓ Expiry: ${expiryRaw} → ${expiryDisplay}`)

      dbg('3. Fetching options chain...')
      const chain = await getChain(ticker, expiryRaw)
      if (!chain.length) throw new Error('Empty options chain')
      dbg(`   ✓ ${chain.length} contracts`)

      const chgPct = parseFloat(quote.change_percentage||0)
      const bearish = scanType==='Put'||scanType==='Put Spread'||(scanType==='Any'&&chgPct<-0.5)
      const optType = bearish?'put':'call'
      const tradeType = scanType==='Any'?(bearish?'Put':'Call'):scanType

      const step = autoStep(price)
      const strikePct = bearish?(2-tfCfg.strikePct):tfCfg.strikePct
      const tgtStrike = Math.round(price*strikePct/step)*step
      const side = chain.filter(o=>o.option_type===optType)
      if (!side.length) throw new Error(`No ${optType} contracts found`)
      const best = side.reduce((a,b)=>Math.abs(b.strike-tgtStrike)<Math.abs(a.strike-tgtStrike)?b:a)
      const bid = parseFloat(best.bid||0)
      const ask = parseFloat(best.ask||0)
      const mid = (bid+ask)/2
      if (mid===0) throw new Error('Bid/ask both $0 — no liquidity')
      const iv    = best.greeks?.mid_iv||best.implied_volatility||0
      const delta = best.greeks?.delta||null
      const theta = best.greeks?.theta||null
      dbg(`   ✓ Strike: $${best.strike}${optType==='call'?'C':'P'} | Bid: ${fmtP(bid)} | Ask: ${fmtP(ask)} | Mid: ${fmtP(mid)}`)
      dbg(`   ✓ IV: ${fmtPct(iv)} | Delta: ${delta?.toFixed(3)||'—'} | Theta: ${theta?.toFixed(3)||'—'}`)

      const entry1 = (mid*0.95).toFixed(2)
      const entry2 = (mid*1.05).toFixed(2)
      const target = (mid*(1+tfCfg.profitTarget)).toFixed(2)
      const stop   = (mid*(1-tfCfg.stopLoss)).toFixed(2)
      dbg(`   ✓ Entry: $${entry1}–$${entry2} | Target: $${target} | Stop: $${stop}`)

      const vol=quote.volume||0, avgVol=quote.average_volume||vol
      const volRatio=vol/(avgVol||1)
      let score=50; const reasons=[],warnings=[]
      if(volRatio>=1.5){score+=15;reasons.push(`Volume ${volRatio.toFixed(1)}x avg`)}
      else if(volRatio<0.8){score-=10;warnings.push(`Low volume ${volRatio.toFixed(1)}x`)}
      if(Math.abs(chgPct)>=1){score+=10;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`)}
      if(iv>=0.20&&iv<=0.50){score+=10;reasons.push(`IV ${(iv*100).toFixed(0)}% ideal`)}
      else if(iv>0.60){warnings.push(`High IV ${(iv*100).toFixed(0)}%`)}
      if(delta&&Math.abs(delta)>=0.35&&Math.abs(delta)<=0.65){score+=10;reasons.push(`Delta ${delta.toFixed(2)}`)}
      if((best.volume||0)>500){score+=5;reasons.push(`${best.volume} contracts on strike`)}
      const hi52=quote.week_52_high||price,lo52=quote.week_52_low||price
      const pos52=(price-lo52)/((hi52-lo52)||1)
      if(pos52>0.75){score+=10;reasons.push('Near 52-week high — strong trend')}
      score=Math.min(95,Math.max(30,score))
      dbg(`   ✓ Conviction: ${score}%`)
      dbg(`✅ All data from Tradier ${tradierMode}`)

      setScanResult({
        ticker, tradeType, score,
        expiryDisplay, expiryRaw,
        strikeStr: `$${best.strike}${optType==='call'?'C':'P'}`,
        entry: `$${entry1} – $${entry2}`,
        target: `$${target} (+${(tfCfg.profitTarget*100).toFixed(0)}%)`,
        stop:   `$${stop} (-${(tfCfg.stopLoss*100).toFixed(0)}%)`,
        grade:  score>=80?'A':score>=65?'B':'C',
        confidence: score>=80?'High':score>=65?'Medium':'Low',
        price:  fmtP(price), bid: fmtP(bid), ask: fmtP(ask), mid: fmtP(mid),
        iv:     fmtPct(iv),
        delta:  delta?delta.toFixed(3):'—',
        theta:  theta?theta.toFixed(3):'—',
        volume: best.volume||0,
        oi:     best.open_interest||0,
        chgPct: chgPct.toFixed(2)+'%',
        volRatio: volRatio.toFixed(1)+'x',
        reasons, warnings,
        tfLabel: tfCfg.label, tfBadge: tfCfg.badge, tfColor: tfCfg.color,
        source: `Tradier ${tradierMode}`,
      })
    } catch(e) {
      setScanErr('❌ '+e.message)
      dbg('ERROR: '+e.message)
    }
    setScanning(false)
  }

  // ─── Futures fetch ────────────────────────────────────────────────────────
  const fetchFutures = async sym => {
    if (!tradierToken) { setFutErr('Add Tradier token in ⚙️ Settings'); return }
    setFutLoading(true); setFutErr(''); setFutData(null)
    const cfg = FUT_SYMBOLS[sym]
    try {
      const quote = await getQuote(cfg.under)
      if (!quote) throw new Error(`No quote for ${cfg.under}`)
      const price = parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')

      const expDates = await getExpiries(cfg.under)
      const expiry = expDates[1]||expDates[0]
      let topCalls=[], topPuts=[], chainLen=0

      if (expiry) {
        const chain = await getChain(cfg.under, expiry)
        chainLen = chain.length
        const calls = chain.filter(o=>o.option_type==='call').sort((a,b)=>(b.open_interest||0)-(a.open_interest||0))
        const puts  = chain.filter(o=>o.option_type==='put').sort((a,b)=>(b.open_interest||0)-(a.open_interest||0))
        topCalls = calls.slice(0,3).map(o=>({strike:o.strike, oi:o.open_interest||0, iv:o.greeks?.mid_iv?(o.greeks.mid_iv*100).toFixed(1)+'%':'—'}))
        topPuts  = puts.slice(0,3).map(o=>({strike:o.strike, oi:o.open_interest||0, iv:o.greeks?.mid_iv?(o.greeks.mid_iv*100).toFixed(1)+'%':'—'}))
      }

      const chgPct = parseFloat(quote.change_percentage||0)
      const chg    = parseFloat(quote.change||0)
      const hi = parseFloat(quote.high||price)
      const lo = parseFloat(quote.low||price)
      const bias = chgPct>0.3?'Bullish':chgPct<-0.3?'Bearish':'Neutral'
      const biasColor = bias==='Bullish'?C.green:bias==='Bearish'?C.red:C.orange

      const resistance = [...new Set([
        ...topCalls.map(s=>s.strike),
        parseFloat(hi.toFixed(2)),
      ])].filter(l=>l>price).sort((a,b)=>a-b).slice(0,3)

      const support = [...new Set([
        ...topPuts.map(s=>s.strike),
        parseFloat(lo.toFixed(2)),
      ])].filter(l=>l<price).sort((a,b)=>b-a).slice(0,3)

      setFutData({
        sym, cfg, price, chg, chgPct, hi, lo, bias, biasColor,
        hi52: parseFloat(quote.week_52_high||price),
        lo52: parseFloat(quote.week_52_low||price),
        vol:  quote.volume||0,
        open: parseFloat(quote.open||price),
        resistance, support, topCalls, topPuts, chainLen,
        fetchedAt: new Date().toLocaleTimeString(),
      })
    } catch(e) {
      setFutErr('❌ '+e.message)
    }
    setFutLoading(false)
  }

  // ─── Alert builder helpers ─────────────────────────────────────────────────
  const buildTgAlert = a => {
    const em = {Call:'🟢📈',Put:'🔴📉','Call Spread':'🟢📐','Put Spread':'🔴📐','Iron Condor':'🦅⚖️',Strangle:'🔀⚖️'}
    return `${em[a.type]||'🎯'} *${a.type.toUpperCase()} ALERT*

📌 *Ticker:* $${(a.ticker||'—').toUpperCase()}
🗓 *Expiry:* ${a.expiry||'—'}
💰 *Strike:* ${a.strike||'—'}
📊 *Entry:* ${a.entry||'—'}
🎯 *Target:* ${a.target||'—'}
🛑 *Stop:* ${a.stop||'—'}
📏 *Size:* ${a.size||'—'}

📝 *Thesis:* ${a.thesis||'—'}
⚡ *Catalyst:* ${a.catalyst||'—'}
🌊 *Flow:* ${a.flow||'—'}

_Not financial advice. Trade at your own risk._`
  }

  const buildScanAlert = r => `${r.tradeType==='Put'||r.tradeType==='Put Spread'?'🔴📉':'🟢📈'} *${r.tradeType.toUpperCase()} ALERT — $${r.ticker}*

🎯 *Conviction: ${r.score}%* | Grade: ${r.grade}
💰 *Stock:* ${r.price} (${r.chgPct} today)
📌 *Strike:* ${r.strikeStr}
🗓 *Expiry:* ${r.expiryDisplay}
📊 *Entry:* ${r.entry}
🎯 *Target:* ${r.target}
🛑 *Stop:* ${r.stop}

📡 *Live Chain:*
Bid: ${r.bid} | Ask: ${r.ask} | Mid: ${r.mid}
IV: ${r.iv} | Delta: ${r.delta} | Vol: ${r.volume}

✅ *Why:*
${(r.reasons||[]).map(x=>'• '+x).join('\n')||'• Momentum setup'}

_Options Edge | ${new Date().toLocaleTimeString()} | Not financial advice_`

  const pushToAlert = r => {
    setAlert(p=>({...p,
      ticker: r.ticker||p.ticker,
      type:   r.tradeType||p.type,
      expiry: r.expiryDisplay||p.expiry,
      strike: r.strikeStr||p.strike,
      entry:  r.entry||p.entry,
      target: r.target||p.target,
      stop:   r.stop||p.stop,
    }))
    setTab(2)
  }

  // ─── Auto scanner ──────────────────────────────────────────────────────────
  const scanOneTicker = useCallback(async ticker => {
    try {
      const quote = await getQuote(ticker)
      if (!quote) return null
      const price = parseFloat(quote.last||quote.prevclose||0)
      if (!price) return null
      const expDates = await getExpiries(ticker)
      if (!expDates.length) return null
      const expiryRaw = expDates[Math.min(2,expDates.length-1)]
      const chain = await getChain(ticker, expiryRaw)
      if (!chain.length) return null

      const chgPct = parseFloat(quote.change_percentage||0)
      const optType = chgPct>=0?'call':'put'
      const price_ = price
      const step = autoStep(price_)
      const tgt = optType==='call'?Math.round(price_*1.02/step)*step:Math.round(price_*0.98/step)*step
      const side = chain.filter(o=>o.option_type===optType)
      if (!side.length) return null
      const best = side.reduce((a,b)=>Math.abs(b.strike-tgt)<Math.abs(a.strike-tgt)?b:a)
      const bid=parseFloat(best.bid||0), ask=parseFloat(best.ask||0), mid=(bid+ask)/2
      if (mid===0) return null

      const iv=best.greeks?.mid_iv||0, delta=best.greeks?.delta||null
      const vol=quote.volume||0, avg=quote.average_volume||vol
      const volRatio=vol/(avg||1)
      let score=50; const reasons=[],warnings=[]
      if(volRatio>=1.5){score+=15;reasons.push(`Vol ${volRatio.toFixed(1)}x avg`)}
      else if(volRatio<0.8){score-=10;warnings.push(`Low vol ${volRatio.toFixed(1)}x`)}
      if(Math.abs(chgPct)>=1){score+=10;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`)}
      if(iv>=0.20&&iv<=0.50){score+=10;reasons.push(`IV ${(iv*100).toFixed(0)}% ideal`)}
      else if(iv>0.60){warnings.push(`High IV ${(iv*100).toFixed(0)}%`)}
      if(delta&&Math.abs(delta)>=0.35&&Math.abs(delta)<=0.65){score+=10;reasons.push(`Delta ${delta.toFixed(2)}`)}
      if((best.volume||0)>500){score+=5;reasons.push(`${best.volume} vol on strike`)}
      score=Math.min(95,Math.max(30,score))

      const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      return {
        ticker, score, tradeType: optType==='call'?'Call':'Put',
        price: fmtP(price), bid: fmtP(bid), ask: fmtP(ask), mid: fmtP(mid),
        iv: fmtPct(iv), delta: delta?delta.toFixed(3):'—',
        volume: best.volume||0, oi: best.open_interest||0,
        strikeStr: `$${best.strike}${optType==='call'?'C':'P'}`,
        expiryDisplay,
        entry: `$${(mid*0.95).toFixed(2)} – $${(mid*1.05).toFixed(2)}`,
        target: `$${(mid*1.80).toFixed(2)} (+80%)`,
        stop:   `$${(mid*0.50).toFixed(2)} (-50%)`,
        grade: score>=80?'A':score>=65?'B':'C',
        chgPct: chgPct.toFixed(2)+'%',
        reasons, warnings,
      }
    } catch { return null }
  }, [tradierToken, tradierMode])

  const runAutoScan = useCallback(async () => {
    if (!tradierToken) return
    const list = watchlist.split(',').map(t=>t.trim().toUpperCase()).filter(Boolean)
    const tickers = list.length ? list : SP500
    const ts = new Date().toLocaleTimeString()
    setAutoLog(p=>[`[${ts}] Scanning ${tickers.length} tickers (${list.length?'custom':'SP500 pool'})...`,...p.slice(0,99)])

    for (const ticker of tickers) {
      const r = await scanOneTicker(ticker)
      const ts2 = new Date().toLocaleTimeString()
      if (!r) { setAutoLog(p=>[`[${ts2}] $${ticker}: no data`,...p.slice(0,99)]); continue }

      setAutoLog(p=>[`[${ts2}] $${ticker}: ${r.score}% ${r.tradeType} ${r.strikeStr} mid:${r.mid}`,...p.slice(0,99)])
      if (r.score >= minScore) {
        setLastAlert(r)
        if (tgToken && tgChatId) {
          const res = await sendTelegram(buildScanAlert(r), tgToken, tgChatId)
          setAutoLog(p=>[`[${ts2}] 🚀 ALERT $${ticker} ${r.score}% → TG: ${res.ok?'✅':'❌'+(res.description||'')}`,...p.slice(0,99)])
        } else {
          setAutoLog(p=>[`[${ts2}] 🚀 $${ticker} ${r.score}% hits threshold — copy alert below`,...p.slice(0,99)])
        }
      }
      await new Promise(res=>setTimeout(res,400))
    }
  }, [tradierToken, tradierMode, watchlist, minScore, tgToken, tgChatId, scanOneTicker])

  const toggleAuto = () => {
    if (autoOn) {
      clearInterval(autoRef.current)
      setAutoOn(false)
      setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] 🔴 Stopped`,...p.slice(0,99)])
    } else {
      if (!tradierToken) { setScanErr('Enter Tradier token in Settings first'); return }
      setAutoOn(true)
      setAutoLog([`[${new Date().toLocaleTimeString()}] 🟢 Started — scanning every ${scanFreq} min`])
      runAutoScan()
      autoRef.current = setInterval(runAutoScan, scanFreq*60*1000)
    }
  }
  useEffect(() => () => clearInterval(autoRef.current), [])

  // ─── Journal helpers ──────────────────────────────────────────────────────
  const addTrade = () => {
    if (!newTrade.ticker) return
    const t = {...newTrade, id:Date.now()+'', date: newTrade.date||new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
    setTrades(p=>[t,...p])
    setNewTrade({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:''})
    setShowAdd(false)
  }

  const gradeCol = g => g==='A'?C.green:g==='B'?C.orange:C.red

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{background:C.bg, minHeight:'100vh', fontFamily:"'IBM Plex Mono',monospace", color:'#c8d8e8'}}>
      <style>{`
        .hv{cursor:pointer;transition:opacity .15s}.hv:hover{opacity:.8}
        .si{animation:si .3s ease}@keyframes si{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        .pulse{animation:pu 1.2s infinite}@keyframes pu{0%,100%{opacity:1}50%{opacity:.4}}
        .tg{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;padding:10px;background:#0a1420;border-bottom:1px solid ${C.border}}
        .tb{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:11px 4px;border-radius:8px;border:1px solid ${C.border};background:transparent;cursor:pointer;transition:all .15s;min-height:56px;gap:3px}
        .tb.on{background:${C.green}18;border-color:${C.green}60}
        .te{font-size:17px;line-height:1}
        .tl{font-size:9px;letter-spacing:.5px;font-family:'IBM Plex Mono';text-transform:uppercase;text-align:center}
        input:focus,textarea:focus,select:focus{outline:none;border-color:#00ff88!important}
        select option{background:#0d1a26}
      `}</style>

      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#0d1520,#0a1a2e)',borderBottom:`1px solid ${C.border}`,padding:'14px 18px 12px'}}>
        <div style={{display:'flex',alignItems:'baseline',gap:10,flexWrap:'wrap'}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,letterSpacing:3,color:C.green,lineHeight:1}}>OPTIONS EDGE</span>
          <span style={{fontSize:9,color:C.dim,letterSpacing:2}}>v3.0</span>
          {tradierToken && <span style={{fontSize:9,color:C.green}}>● {tradierMode.toUpperCase()}</span>}
        </div>
      </div>

      {/* Tab grid */}
      <div className="tg">
        {TABS.map((t,i) => (
          <button key={i} className={`tb${tab===i?' on':''}`} onClick={()=>setTab(i)} style={{color:tab===i?C.green:C.dim}}>
            <span className="te">{t.e}</span>
            <span className="tl">{t.l}</span>
          </button>
        ))}
      </div>

      <div style={{padding:'16px 18px',maxWidth:900}}>

        {/* ══ STRATEGY ═══════════════════════════════════════════════════════ */}
        {tab===0 && (
          <div className="si">
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:C.green,letterSpacing:2,marginBottom:14}}>STRATEGY RULES</div>
            {[
              {t:'CALLS & PUTS', c:C.green, rules:['2+ TA signals required before entry','Avoid RSI > 75 (calls) or < 25 (puts)','Volume 1.5x+ above 20-day average','MACD crossover confirms direction','Options flow sweep = green light','21–45 DTE swings, 5–14 DTE quick plays']},
              {t:'SPREADS', c:C.blue, rules:['Debit spreads when IVR < 30','Credit spreads when IVR > 50','Short strike at key S/R level','Min 1:1 risk/reward, target 1:2','Width: 5–10pts SPX, 2.5–5 stocks','Target 50–65% of max profit on credit']},
              {t:'CONDORS & STRANGLES', c:C.orange, rules:['IVR > 50 ideally > 70','No earnings/events within expiry','ATR contracting 5+ sessions','Sell 1–2 SD OTM strikes','Collect 25–33% of width as credit','Close at 50% profit or 21 DTE']},
            ].map((s,i) => (
              <div key={i} style={{marginBottom:14}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:s.c,letterSpacing:2,marginBottom:7}}>{s.t}</div>
                {s.rules.map((r,j) => (
                  <div key={j} style={{display:'flex',gap:9,marginBottom:4,fontSize:12,color:'#8ab0c0'}}>
                    <span style={{color:s.c,flexShrink:0}}>→</span>{r}
                  </div>
                ))}
              </div>
            ))}
            <div style={{background:'#050c14',border:`1px dashed ${C.border}`,borderRadius:4,padding:12,marginTop:6,fontSize:12,color:'#6a9aaa'}}>
              <span style={{fontSize:9,color:C.dim,letterSpacing:2}}>GOLDEN RULE — </span>
              Require <span style={{color:C.green}}>2+ TA signals</span> + <span style={{color:C.blue}}>1 flow signal</span> or <span style={{color:C.orange}}>1 catalyst</span> before entry.
            </div>
          </div>
        )}

        {/* ══ CHECKLIST ══════════════════════════════════════════════════════ */}
        {tab===1 && (
          <div className="si">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:8}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:clColor,letterSpacing:2}}>
                  {clScore}% — {clScore>=80?'STRONG SETUP 🔥':clScore>=60?'CAUTION ⚠️':'SKIP THIS TRADE ❌'}
                </div>
                <div style={{fontSize:10,color:C.dim,marginTop:2}}>{Object.values(checked).filter(Boolean).length} of {CHECKLIST.length} met</div>
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <div style={{width:80,height:5,background:C.border,borderRadius:3,overflow:'hidden'}}>
                  <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s'}}/>
                </div>
                <button className="hv" onClick={()=>setChecked({})} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'5px 10px',borderRadius:4,fontSize:10,cursor:'pointer'}}>RESET</button>
              </div>
            </div>
            {['TA','Flow','News','Risk'].map(cat => (
              <div key={cat} style={{marginBottom:14}}>
                <div style={{fontSize:9,letterSpacing:2,color:CAT_COLOR[cat],marginBottom:7,display:'flex',alignItems:'center',gap:7}}>
                  <span style={{display:'inline-block',width:14,height:1.5,background:CAT_COLOR[cat]}}/>
                  {cat==='TA'?'TECHNICAL ANALYSIS':cat==='Flow'?'OPTIONS FLOW':cat==='News'?'NEWS & CATALYST':'RISK MANAGEMENT'}
                </div>
                {CHECKLIST.filter(i=>i.cat===cat).map(item => (
                  <div key={item.id} className="hv" onClick={()=>setChecked(p=>({...p,[item.id]:!p[item.id]}))}
                    style={{display:'flex',gap:10,padding:'8px 11px',borderRadius:4,marginBottom:4,
                      background:checked[item.id]?`${CAT_COLOR[cat]}0a`:C.card,
                      border:`1px solid ${checked[item.id]?CAT_COLOR[cat]+'40':C.border}`}}>
                    <div style={{width:15,height:15,borderRadius:3,border:`2px solid ${checked[item.id]?CAT_COLOR[cat]:'#2a4a5a'}`,background:checked[item.id]?CAT_COLOR[cat]:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1}}>
                      {checked[item.id] && <span style={{color:'#000',fontSize:9,fontWeight:700}}>✓</span>}
                    </div>
                    <div>
                      <div style={{fontSize:12,color:checked[item.id]?'#c8d8e8':'#8ab0c0',fontWeight:checked[item.id]?600:400}}>{item.l}</div>
                      <div style={{fontSize:11,color:'#3a5a6a',marginTop:1}}>{item.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ══ ALERT BUILDER ══════════════════════════════════════════════════ */}
        {tab===2 && (
          <div className="si">
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9,marginBottom:10}}>
              <Field label="Trade Type" value={alert.type} onChange={v=>setAlert(p=>({...p,type:v}))} options={['Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
              <Field label="Ticker" value={alert.ticker} onChange={v=>setAlert(p=>({...p,ticker:v.toUpperCase()}))} placeholder="NVDA"/>
              <Field label="Expiry" value={alert.expiry} onChange={v=>setAlert(p=>({...p,expiry:v}))} placeholder="May 16 2026"/>
              <Field label="Strike" value={alert.strike} onChange={v=>setAlert(p=>({...p,strike:v}))} placeholder="210C"/>
              <Field label="Entry" value={alert.entry} onChange={v=>setAlert(p=>({...p,entry:v}))} placeholder="$3.50 – $3.80"/>
              <Field label="Target" value={alert.target} onChange={v=>setAlert(p=>({...p,target:v}))} placeholder="$6.50 (+85%)"/>
              <Field label="Stop Loss" value={alert.stop} onChange={v=>setAlert(p=>({...p,stop:v}))} placeholder="$1.75 (-50%)"/>
              <Field label="Size" value={alert.size} onChange={v=>setAlert(p=>({...p,size:v}))} placeholder="1–3 contracts"/>
            </div>
            <div style={{display:'grid',gap:9,marginBottom:14}}>
              <Field label="Trade Thesis" value={alert.thesis} onChange={v=>setAlert(p=>({...p,thesis:v}))} placeholder="Why you're entering..." rows={2}/>
              <Field label="Catalyst" value={alert.catalyst} onChange={v=>setAlert(p=>({...p,catalyst:v}))} placeholder="Earnings, event, breakout..." rows={1}/>
              <Field label="Options Flow" value={alert.flow} onChange={v=>setAlert(p=>({...p,flow:v}))} placeholder="Unusual sweeps, dark pool..." rows={1}/>
            </div>
            <Card color={C.border} style={{background:'#050c14'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <Lbl>📱 Telegram Preview</Lbl>
                <div style={{display:'flex',gap:7}}>
                  <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildTgAlert(alert));setCopied(true);setTimeout(()=>setCopied(false),2000)}} style={{background:copied?`${C.green}20`:'transparent',border:`1px solid ${copied?C.green:C.border}`,color:copied?C.green:C.dim,padding:'6px 12px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>
                    {copied?'✅ COPIED':'📋 COPY'}
                  </button>
                  {tgToken&&tgChatId&&(
                    <button className="hv" onClick={async()=>{const r=await sendTelegram(buildTgAlert(alert),tgToken,tgChatId);setTgStatus(r.ok?'✅ Sent!':'❌ '+r.description);setTimeout(()=>setTgStatus(''),4000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>
                      📤 SEND
                    </button>
                  )}
                </div>
              </div>
              {tgStatus && <div style={{fontSize:11,color:C.green,marginBottom:8}}>{tgStatus}</div>}
              <pre style={{fontSize:11,lineHeight:1.8,color:'#8ab0c0',margin:0,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{buildTgAlert(alert)}</pre>
            </Card>
          </div>
        )}

        {/* ══ EXIT RULES ═════════════════════════════════════════════════════ */}
        {tab===3 && (
          <div className="si">
            {EXIT_RULES.map((sec,i) => (
              <div key={i} style={{marginBottom:18}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:17,color:sec.color,letterSpacing:2,marginBottom:8}}>{sec.type}</div>
                {sec.rules.map((r,j) => (
                  <div key={j} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${sec.color}`,borderRadius:4,padding:'9px 13px',display:'grid',gridTemplateColumns:'110px 1fr',gap:10,alignItems:'center',marginBottom:5}}>
                    <span style={{fontSize:9,color:sec.color,letterSpacing:1,fontWeight:600}}>{r.tr.toUpperCase()}</span>
                    <span style={{fontSize:12,color:'#8ab0c0',lineHeight:1.5}}>{r.a}</span>
                  </div>
                ))}
              </div>
            ))}
            <Card color={`${C.red}50`}>
              <Lbl color={C.red}>⚠️ CARDINAL RULES</Lbl>
              {['Never widen your stop to give it more room','If unsure whether to exit — exit. Re-enter later','Always post exits to your Telegram channel','Partial exits: book 50% at target, trail the rest'].map((r,i) => (
                <div key={i} style={{display:'flex',gap:8,marginBottom:5,fontSize:12,color:'#8ab0c0'}}>
                  <span style={{color:C.red,flexShrink:0}}>→</span>{r}
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ══ JOURNAL ════════════════════════════════════════════════════════ */}
        {tab===4 && (
          <div className="si">
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(100px,1fr))',gap:6,marginBottom:16}}>
              {[
                {l:'TOTAL P&L', v:(jStats.pnl>=0?'+':'-')+'$'+Math.abs(jStats.pnl).toFixed(0), c:jStats.pnl>=0?C.green:C.red},
                {l:'WIN RATE',  v:jStats.wr+'%', c:jStats.wr>=60?C.green:jStats.wr>=45?C.orange:C.red},
                {l:'AVG WIN',   v:'+$'+jStats.aw.toFixed(0), c:C.green},
                {l:'AVG LOSS',  v:'$'+jStats.al.toFixed(0),  c:C.red},
                {l:'CLOSED',    v:String(jStats.total), c:C.dim},
                {l:'OPEN',      v:String(jStats.open),  c:C.blue},
              ].map((s,i) => (
                <Card key={i}>
                  <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:s.c,letterSpacing:1}}>{s.v}</div>
                </Card>
              ))}
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:6}}>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {['All','Open','Closed','Stopped'].map(f => <Pill key={f} label={f} active={jFilter===f} color={C.blue} onClick={()=>setJFilter(f)}/>)}
              </div>
              <button className="hv" onClick={()=>setShowAdd(p=>!p)} style={{background:showAdd?`${C.green}20`:'transparent',border:`1px solid ${showAdd?C.green:C.border}`,color:showAdd?C.green:C.dim,padding:'6px 12px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>+ LOG TRADE</button>
            </div>
            {showAdd && (
              <Card color={`${C.green}40`} style={{marginBottom:12}}>
                <Lbl color={C.green}>NEW TRADE ENTRY</Lbl>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:7,marginBottom:7}}>
                  <Field label="Ticker" value={newTrade.ticker} onChange={v=>setNewTrade(p=>({...p,ticker:v.toUpperCase()}))} placeholder="NVDA"/>
                  <Field label="Type" value={newTrade.type} onChange={v=>setNewTrade(p=>({...p,type:v}))} options={['Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
                  <Field label="Status" value={newTrade.status} onChange={v=>setNewTrade(p=>({...p,status:v}))} options={['Open','Closed','Stopped']}/>
                  <Field label="Entry $" value={newTrade.entry} onChange={v=>setNewTrade(p=>({...p,entry:v}))} placeholder="$3.50"/>
                  <Field label="Exit $" value={newTrade.exitPrice} onChange={v=>setNewTrade(p=>({...p,exitPrice:v}))} placeholder="$6.50"/>
                  <Field label="P&L $" value={newTrade.pnl} onChange={v=>setNewTrade(p=>({...p,pnl:v}))} placeholder="+320"/>
                  <Field label="Qty" value={newTrade.contracts} onChange={v=>setNewTrade(p=>({...p,contracts:v}))} placeholder="2"/>
                  <Field label="Expiry" value={newTrade.expiry} onChange={v=>setNewTrade(p=>({...p,expiry:v}))} placeholder="May 16 2026"/>
                  <Field label="Date" value={newTrade.date} onChange={v=>setNewTrade(p=>({...p,date:v}))} placeholder="Apr 27 2026"/>
                </div>
                <div style={{marginBottom:8}}>
                  <Field label="Notes" value={newTrade.notes} onChange={v=>setNewTrade(p=>({...p,notes:v}))} placeholder="What worked, what didn't..." rows={2}/>
                </div>
                <div style={{display:'flex',gap:7}}>
                  <button className="hv" onClick={addTrade} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'6px 16px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>SAVE</button>
                  <button className="hv" onClick={()=>setShowAdd(false)} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'6px 12px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>CANCEL</button>
                </div>
              </Card>
            )}
            {(jFilter==='All'?trades:trades.filter(t=>t.status===jFilter)).length===0
              ? <div style={{color:C.dim,fontSize:12,textAlign:'center',padding:24,border:`1px dashed ${C.border}`,borderRadius:6}}>No trades yet. Hit <span style={{color:C.green}}>+ LOG TRADE</span> to start.</div>
              : (jFilter==='All'?trades:trades.filter(t=>t.status===jFilter)).map(t => {
                  const pnl=parseFloat(t.pnl||0)
                  const stC=t.status==='Open'?C.blue:t.status==='Closed'?C.green:C.red
                  return (
                    <div key={t.id} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${stC}`,borderRadius:4,padding:'10px 13px',marginBottom:6}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:6}}>
                        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
                          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:'#c8d8e8',letterSpacing:2}}>${t.ticker}</span>
                          <span style={{fontSize:9,color:stC,border:`1px solid ${stC}40`,padding:'2px 6px',borderRadius:3}}>{t.status.toUpperCase()}</span>
                          <span style={{fontSize:11,color:C.dim}}>{t.type}</span>
                          {t.expiry && <span style={{fontSize:10,color:C.dim}}>{t.expiry}</span>}
                          {t.date   && <span style={{fontSize:9,color:'#2a4a5a'}}>{t.date}</span>}
                        </div>
                        <div style={{display:'flex',gap:8,alignItems:'center'}}>
                          {t.pnl && <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:pnl>=0?C.green:C.red}}>{pnl>=0?'+':'-'}${Math.abs(pnl)}</span>}
                          <button className="hv" onClick={()=>setTrades(p=>p.filter(x=>x.id!==t.id))} style={{background:'transparent',border:'none',color:'#2a4a5a',fontSize:12,cursor:'pointer'}}>✕</button>
                        </div>
                      </div>
                      {(t.entry||t.exitPrice) && (
                        <div style={{display:'flex',gap:12,marginTop:6,fontSize:11,color:C.dim}}>
                          {t.entry     && <span>Entry: <span style={{color:'#8ab0c0'}}>{t.entry}</span></span>}
                          {t.exitPrice && <span>Exit: <span style={{color:'#8ab0c0'}}>{t.exitPrice}</span></span>}
                          {t.contracts && <span>Qty: <span style={{color:'#8ab0c0'}}>{t.contracts}</span></span>}
                        </div>
                      )}
                      {t.notes && <div style={{marginTop:6,fontSize:11,color:'#4a6a7a',lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:5}}>{t.notes}</div>}
                    </div>
                  )
                })
            }
          </div>
        )}

        {/* ══ SCANNER ════════════════════════════════════════════════════════ */}
        {tab===5 && (
          <div className="si">
            {!tradierToken && (
              <div style={{background:'#1a0a00',border:`1px solid ${C.orange}`,borderRadius:6,padding:12,marginBottom:12,fontSize:12,color:C.orange,lineHeight:1.6}}>
                ⚠️ No Tradier token set. Go to <strong>⚙️ Settings</strong> → paste your token.
              </div>
            )}

            {/* Timeframe selector */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:7}}>TIMEFRAME</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {Object.entries(TF_CONFIG).map(([key,cfg]) => {
                  const active = scanTF===key
                  return (
                    <button key={key} className="hv" onClick={()=>{setScanTF(key);setScanResult(null)}} style={{
                      padding:'9px 11px', borderRadius:6, cursor:'pointer', textAlign:'left',
                      background:active?`${cfg.color}18`:C.card,
                      border:`1px solid ${active?cfg.color:C.border}`,
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                        <span style={{fontSize:13}}>{cfg.badge}</span>
                        <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:12,letterSpacing:1.5,color:active?cfg.color:'#c8d8e8'}}>{cfg.label}</span>
                        {active && <span style={{marginLeft:'auto',fontSize:8,color:cfg.color,border:`1px solid ${cfg.color}`,padding:'1px 4px',borderRadius:2}}>ACTIVE</span>}
                      </div>
                      <div style={{fontSize:10,color:active?cfg.color+'cc':C.dim}}>{cfg.desc}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Ticker + type */}
            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:9,marginBottom:12}}>
              <div>
                <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>TICKER SYMBOL</div>
                <input value={scanTicker} onChange={e=>{setScanTicker(e.target.value.toUpperCase());setScanResult(null)}}
                  placeholder="NVDA, AAPL, SPY..." onKeyDown={e=>e.key==='Enter'&&runScan()}
                  style={{...iSt,fontSize:20,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:2}}/>
              </div>
              <Field label="Type" value={scanType} onChange={setScanType} options={['Any','Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
            </div>

            <button className="hv" onClick={runScan} disabled={scanning||!scanTicker||!tradierToken} style={{
              width:'100%', padding:'13px', borderRadius:6, fontSize:14, letterSpacing:2, cursor:'pointer',
              fontFamily:"'Bebas Neue',sans-serif", marginBottom:14,
              background:scanning?`${C.green}10`:`${C.green}22`,
              border:`1px solid ${scanning||!scanTicker||!tradierToken?C.border:C.green}`,
              color:scanning||!scanTicker||!tradierToken?C.dim:C.green,
            }}>
              {scanning
                ? <span className="pulse">🔴 FETCHING LIVE DATA — ${scanTicker}...</span>
                : `🔍 SCAN $${scanTicker||'TICKER'} — LIVE TRADIER DATA`
              }
            </button>

            {scanErr && <div style={{background:'#1a0a10',border:`1px solid ${C.red}40`,borderRadius:6,padding:11,color:C.red,fontSize:12,marginBottom:12,lineHeight:1.6}}>{scanErr}</div>}

            {debugLog.length>0 && (
              <div style={{background:'#02080e',border:`1px solid ${C.border}`,borderRadius:6,padding:11,marginBottom:12,maxHeight:150,overflowY:'auto'}}>
                <Lbl>📡 Live Tradier Feed</Lbl>
                {debugLog.map((l,i) => (
                  <div key={i} style={{fontSize:11,color:l.startsWith('✅')?C.green:l.includes('ERROR')||l.includes('❌')?C.red:'#4a8a9a',fontFamily:'monospace',lineHeight:1.7}}>{l}</div>
                ))}
              </div>
            )}

            {scanResult && (
              <div className="si">
                {/* Grade header */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12,flexWrap:'wrap',gap:10}}>
                  <div style={{display:'flex',gap:12,alignItems:'center'}}>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:56,color:gradeCol(scanResult.grade),lineHeight:1}}>{scanResult.grade}</div>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:'#c8d8e8',letterSpacing:2}}>${scanResult.ticker} — {scanResult.tradeType}</div>
                      <div style={{fontSize:11,color:C.dim,marginTop:1}}>Conviction: <span style={{color:scanResult.score>=80?C.green:C.orange}}>{scanResult.score}%</span> · {scanResult.confidence}</div>
                      <div style={{display:'inline-flex',alignItems:'center',gap:5,marginTop:4,padding:'2px 7px',borderRadius:4,background:`${scanResult.tfColor}18`,border:`1px solid ${scanResult.tfColor}40`}}>
                        <span style={{fontSize:11}}>{scanResult.tfBadge}</span>
                        <span style={{fontSize:9,color:scanResult.tfColor,letterSpacing:1}}>{scanResult.tfLabel}</span>
                      </div>
                    </div>
                  </div>
                  <button className="hv" onClick={()=>pushToAlert(scanResult)} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'8px 15px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>→ ALERT BUILDER</button>
                </div>

                {/* Live chain box */}
                <div style={{background:'#030d18',border:`1px solid ${C.blue}50`,borderRadius:6,padding:11,marginBottom:11}}>
                  <Lbl color={C.blue}>📡 Live Options Chain — Tradier {tradierMode}</Lbl>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(75px,1fr))',gap:5}}>
                    {[
                      {l:'STOCK',v:scanResult.price,    c:'#c8d8e8'},
                      {l:'BID',  v:scanResult.bid,      c:C.red},
                      {l:'ASK',  v:scanResult.ask,      c:C.green},
                      {l:'MID',  v:scanResult.mid,      c:C.blue},
                      {l:'IV',   v:scanResult.iv,       c:C.orange},
                      {l:'DELTA',v:scanResult.delta,    c:'#c8d8e8'},
                      {l:'THETA',v:scanResult.theta,    c:C.red},
                      {l:'VOL',  v:scanResult.volume,   c:C.dim},
                      {l:'O.I.', v:scanResult.oi,       c:C.dim},
                      {l:'CHG',  v:scanResult.chgPct,   c:scanResult.chgPct?.startsWith('-')?C.red:C.green},
                    ].map((f,i) => (
                      <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:'6px 8px'}}>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>{f.l}</div>
                        <div style={{fontSize:11,color:f.c,fontWeight:600}}>{safe(f.v)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Trade setup */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(115px,1fr))',gap:6,marginBottom:10}}>
                  {[
                    {l:'EXPIRY', v:scanResult.expiryDisplay, c:'#c8d8e8'},
                    {l:'STRIKE', v:scanResult.strikeStr,     c:'#c8d8e8'},
                    {l:'ENTRY',  v:scanResult.entry,         c:C.blue},
                    {l:'TARGET', v:scanResult.target,        c:C.green},
                    {l:'STOP',   v:scanResult.stop,          c:C.red},
                  ].map((f,i) => (
                    <Card key={i}>
                      <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{f.l}</div>
                      <div style={{fontSize:12,color:f.c,fontWeight:600}}>{f.v}</div>
                    </Card>
                  ))}
                </div>

                {scanResult.reasons?.length>0 && (
                  <Card style={{marginBottom:7}}>
                    <Lbl color={C.green}>✅ WHY THIS TRADE</Lbl>
                    {scanResult.reasons.map((r,i) => <div key={i} style={{fontSize:12,color:'#8ab0c0',lineHeight:1.7}}>• {r}</div>)}
                  </Card>
                )}
                {scanResult.warnings?.length>0 && (
                  <Card color={`${C.orange}40`}>
                    <Lbl color={C.orange}>⚠️ WATCH</Lbl>
                    {scanResult.warnings.map((w,i) => <div key={i} style={{fontSize:12,color:'#8a7060',lineHeight:1.7}}>• {w}</div>)}
                  </Card>
                )}
              </div>
            )}
          </div>
        )}

        {/* ══ FUTURES ════════════════════════════════════════════════════════ */}
        {tab===6 && (
          <div className="si">
            {/* Symbol buttons */}
            <div style={{display:'flex',gap:7,marginBottom:14,flexWrap:'wrap'}}>
              {Object.entries(FUT_SYMBOLS).map(([sym,cfg]) => (
                <button key={sym} className="hv" onClick={()=>{setFutSym(sym);setFutData(null);setFutErr('')}} style={{
                  padding:'8px 16px', borderRadius:5, cursor:'pointer',
                  fontFamily:"'Bebas Neue',sans-serif", fontSize:14, letterSpacing:2,
                  border:`1px solid ${futSym===sym?C.green:C.border}`,
                  color:futSym===sym?C.green:C.dim,
                  background:futSym===sym?`${C.green}18`:C.card,
                }}>
                  {sym}
                </button>
              ))}
            </div>

            <button className="hv" onClick={()=>fetchFutures(futSym)} disabled={futLoading||!tradierToken} style={{
              width:'100%', padding:'12px', borderRadius:6, fontSize:13, letterSpacing:2,
              fontFamily:"'Bebas Neue',sans-serif", marginBottom:12, cursor:'pointer',
              background:futLoading?`${C.blue}10`:`${C.blue}22`,
              border:`1px solid ${futLoading||!tradierToken?C.border:C.blue}`,
              color:futLoading||!tradierToken?C.dim:C.blue,
            }}>
              {futLoading
                ? <span className="pulse">🔴 FETCHING — {FUT_SYMBOLS[futSym]?.name}...</span>
                : `📡 FETCH LIVE ${futSym} — ${FUT_SYMBOLS[futSym]?.name}`
              }
            </button>

            {!tradierToken && <div style={{background:'#1a0a00',border:`1px solid ${C.orange}`,borderRadius:6,padding:11,marginBottom:11,fontSize:12,color:C.orange}}>⚠️ Add Tradier token in ⚙️ Settings first</div>}
            {futErr && <div style={{background:'#1a0a10',border:`1px solid ${C.red}40`,borderRadius:6,padding:11,color:C.red,fontSize:12,marginBottom:11}}>{futErr}</div>}

            {futData && (
              <div className="si">
                {/* Price header */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12,flexWrap:'wrap',gap:8}}>
                  <div>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:'#c8d8e8',letterSpacing:2,lineHeight:1}}>{futData.sym} <span style={{fontSize:13,color:C.dim}}>via {futData.cfg.under}</span></div>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:40,color:futData.biasColor,letterSpacing:1,lineHeight:1.1}}>${futData.price.toFixed(2)}</div>
                    <div style={{display:'flex',gap:10,alignItems:'center',marginTop:4,flexWrap:'wrap'}}>
                      <span style={{fontSize:13,color:futData.chgPct>=0?C.green:C.red,fontWeight:600}}>
                        {futData.chgPct>=0?'+':''}{futData.chgPct.toFixed(2)}% ({futData.chg>=0?'+':''}{futData.chg.toFixed(2)})
                      </span>
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:1.5,color:futData.biasColor,padding:'2px 8px',borderRadius:4,background:`${futData.biasColor}20`,border:`1px solid ${futData.biasColor}40`}}>{futData.bias}</span>
                      <span style={{fontSize:10,color:C.dim}}>Updated: {futData.fetchedAt}</span>
                    </div>
                  </div>
                  <button className="hv" onClick={()=>fetchFutures(futData.sym)} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'7px 14px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>🔄 REFRESH</button>
                </div>

                {/* OHLC stats */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(80px,1fr))',gap:5,marginBottom:12}}>
                  {[
                    {l:'OPEN',    v:'$'+futData.open.toFixed(2),  c:'#c8d8e8'},
                    {l:'HIGH',    v:'$'+futData.hi.toFixed(2),    c:C.green},
                    {l:'LOW',     v:'$'+futData.lo.toFixed(2),    c:C.red},
                    {l:'52W HIGH',v:'$'+futData.hi52.toFixed(2),  c:C.green},
                    {l:'52W LOW', v:'$'+futData.lo52.toFixed(2),  c:C.red},
                    {l:'CHAIN',   v:futData.chainLen+' contracts', c:C.dim},
                  ].map((f,i) => (
                    <Card key={i}>
                      <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{f.l}</div>
                      <div style={{fontSize:11,color:f.c,fontWeight:600}}>{f.v}</div>
                    </Card>
                  ))}
                </div>

                {/* Resistance & Support */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
                  <div style={{background:'#040d06',border:`1px solid ${C.red}40`,borderRadius:6,padding:13}}>
                    <Lbl color={C.red}>🔴 RESISTANCE</Lbl>
                    <div style={{fontSize:10,color:'#3a4a3a',marginBottom:8}}>Top call OI + session high</div>
                    {futData.resistance.length===0
                      ? <div style={{fontSize:12,color:C.dim}}>No resistance levels found</div>
                      : futData.resistance.map((lvl,i) => (
                          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<futData.resistance.length-1?`1px solid ${C.border}`:'none'}}>
                            <div>
                              <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.red,letterSpacing:1}}>${lvl.toFixed(2)}</span>
                              {i===0 && <span style={{fontSize:8,color:C.red,marginLeft:5,border:`1px solid ${C.red}40`,padding:'1px 4px',borderRadius:2}}>NEAREST</span>}
                            </div>
                            <span style={{fontSize:10,color:C.dim}}>+{((lvl/futData.price-1)*100).toFixed(1)}%</span>
                          </div>
                        ))
                    }
                    {futData.topCalls.length>0 && (
                      <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${C.border}`}}>
                        <div style={{fontSize:8,color:C.dim,letterSpacing:1.5,marginBottom:5}}>TOP CALL OI</div>
                        {futData.topCalls.map((s,i) => (
                          <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#5a8a6a',marginBottom:2}}>
                            <span>${s.strike}C</span>
                            <span>OI: {s.oi.toLocaleString()} · {s.iv}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{background:'#04080d',border:`1px solid ${C.green}40`,borderRadius:6,padding:13}}>
                    <Lbl color={C.green}>🟢 SUPPORT</Lbl>
                    <div style={{fontSize:10,color:'#3a4a3a',marginBottom:8}}>Top put OI + session low</div>
                    {futData.support.length===0
                      ? <div style={{fontSize:12,color:C.dim}}>No support levels found</div>
                      : futData.support.map((lvl,i) => (
                          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<futData.support.length-1?`1px solid ${C.border}`:'none'}}>
                            <div>
                              <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.green,letterSpacing:1}}>${lvl.toFixed(2)}</span>
                              {i===0 && <span style={{fontSize:8,color:C.green,marginLeft:5,border:`1px solid ${C.green}40`,padding:'1px 4px',borderRadius:2}}>NEAREST</span>}
                            </div>
                            <span style={{fontSize:10,color:C.dim}}>{(((lvl/futData.price)-1)*100).toFixed(1)}%</span>
                          </div>
                        ))
                    }
                    {futData.topPuts.length>0 && (
                      <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${C.border}`}}>
                        <div style={{fontSize:8,color:C.dim,letterSpacing:1.5,marginBottom:5}}>TOP PUT OI</div>
                        {futData.topPuts.map((s,i) => (
                          <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#5a6a8a',marginBottom:2}}>
                            <span>${s.strike}P</span>
                            <span>OI: {s.oi.toLocaleString()} · {s.iv}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Summary */}
                <Card color={`${futData.biasColor}40`}>
                  <Lbl color={futData.biasColor}>📊 MARKET STRUCTURE</Lbl>
                  <div style={{fontSize:12,color:'#8ab0c0',lineHeight:2}}>
                    <span style={{color:futData.biasColor,fontWeight:600}}>{futData.sym}</span> proxy trading at <span style={{color:'#c8d8e8',fontWeight:600}}>${futData.price.toFixed(2)}</span>, <span style={{color:futData.chgPct>=0?C.green:C.red}}>{futData.chgPct>=0?'up':'down'} {Math.abs(futData.chgPct).toFixed(2)}%</span> today.
                    {' '}Bias: <span style={{color:futData.biasColor,fontWeight:600}}>{futData.bias}</span> · Range: <span style={{color:C.red}}>${futData.lo.toFixed(2)}</span> – <span style={{color:C.green}}>${futData.hi.toFixed(2)}</span><br/>
                    Nearest resistance: <span style={{color:C.red,fontWeight:600}}>${futData.resistance[0]?.toFixed(2)||'—'}</span> · Nearest support: <span style={{color:C.green,fontWeight:600}}>${futData.support[0]?.toFixed(2)||'—'}</span><br/>
                    Main line in the sand: <span style={{color:'#c8d8e8',fontWeight:600}}>${futData.support[0]?.toFixed(2)||'—'}</span>
                  </div>
                </Card>

                <div style={{marginTop:8,fontSize:10,color:'#2a4a5a',textAlign:'center'}}>
                  Data via Tradier {tradierMode} · Proxy ETF: {futData.cfg.under} · S/R from top OI strikes
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ SETTINGS ═══════════════════════════════════════════════════════ */}
        {tab===7 && (
          <div className="si">

            {/* Tradier */}
            <Card style={{marginBottom:14}}>
              <Lbl color={C.blue}>📡 TRADIER API</Lbl>
              <div style={{background:'#020c14',border:`1px solid ${C.blue}30`,borderRadius:5,padding:11,marginBottom:11,fontSize:11,color:'#5a8aaa',lineHeight:1.9}}>
                <strong style={{color:C.green}}>How to get your token:</strong><br/>
                1. Go to <strong>tradier.com</strong> → Sign up free<br/>
                2. Dashboard → <strong>API Access</strong> → copy <strong>Bearer Token</strong><br/>
                3. Production = real live data (free tier = 15-min delayed, $10/mo = real-time)<br/>
                4. Sandbox = simulated test data only — prices are not real
              </div>
              <div style={{display:'grid',gap:9,marginBottom:9}}>
                <Field label="Tradier Bearer Token" value={tradierToken} onChange={setTradierToken} placeholder="Paste your Bearer token here" type="password"/>
                <Field label="API Mode" value={tradierMode} onChange={setTradierMode} options={[{v:'production',l:'🟢 Production — Real live data (recommended)'},{v:'sandbox',l:'🟡 Sandbox — Simulated data (testing only)'}]}/>
              </div>
              {tradierToken && <div style={{fontSize:11,color:C.green}}>✓ Token set — using <strong>{tradierMode}</strong></div>}
            </Card>

            {/* Telegram */}
            <Card style={{marginBottom:14}}>
              <Lbl color={C.blue}>📱 TELEGRAM AUTO-ALERTS</Lbl>
              <div style={{background:'#020c14',border:`1px solid ${C.blue}30`,borderRadius:5,padding:11,marginBottom:11,fontSize:11,color:'#5a8aaa',lineHeight:1.9}}>
                <strong style={{color:C.green}}>Setup (3 steps):</strong><br/>
                1. Telegram → search <strong>@BotFather</strong> → /newbot → copy Bot Token<br/>
                2. Add bot to your channel as admin<br/>
                3. Get Chat ID: for a channel use @YourChannel or visit<br/>
                {"api.telegram.org/bot{TOKEN}/getUpdates"} after sending a message to your bot
              </div>
              <div style={{display:'grid',gap:9,marginBottom:11}}>
                <Field label="Bot Token" value={tgToken} onChange={setTgToken} placeholder="7123456789:AAFxxxxxxxxxxxxx" type="password"/>
                <Field label="Chat ID or @ChannelName" value={tgChatId} onChange={setTgChatId} placeholder="-1001234567890 or @YourChannel"/>
              </div>
              <div style={{display:'flex',gap:9,alignItems:'center',flexWrap:'wrap'}}>
                <button className="hv" onClick={async()=>{
                  setTgStatus('sending...')
                  const r = await sendTelegram(`🤖 *OPTIONS EDGE Connected!*\n\nAlerts active at ${minScore}%+ conviction.\n\n_${new Date().toLocaleString()}_`, tgToken, tgChatId)
                  setTgStatus(r.ok?'✅ Message sent!':'❌ Failed: '+(r.description||r.error||'check token/chat ID'))
                  setTimeout(()=>setTgStatus(''),5000)
                }} disabled={!tgToken||!tgChatId} style={{background:tgToken&&tgChatId?`${C.blue}20`:'transparent',border:`1px solid ${tgToken&&tgChatId?C.blue:C.border}`,color:tgToken&&tgChatId?C.blue:C.dim,padding:'7px 18px',borderRadius:4,fontSize:11,letterSpacing:1,cursor:tgToken&&tgChatId?'pointer':'not-allowed'}}>
                  📤 SEND TEST MESSAGE
                </button>
                {tgStatus && <span style={{fontSize:12,color:tgStatus.startsWith('✅')?C.green:C.red}}>{tgStatus}</span>}
              </div>
            </Card>

            {/* Auto-scanner */}
            <Card color={autoOn?`${C.green}60`:C.border} style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
                <div>
                  <div style={{fontSize:10,color:autoOn?C.green:C.blue,letterSpacing:2,display:'flex',alignItems:'center',gap:7}}>
                    <span style={{width:7,height:7,borderRadius:'50%',background:autoOn?C.green:C.dim,display:'inline-block',boxShadow:autoOn?`0 0 8px ${C.green}`:'none'}}/>
                    {autoOn?'AUTO-SCANNER ACTIVE':'AUTO-SCANNER — OFF'}
                  </div>
                  <div style={{fontSize:10,color:C.dim,marginTop:2}}>
                    Every {scanFreq} min · {minScore}%+ conviction · {tgToken&&tgChatId?'✅ Telegram connected':'⚠️ Add Telegram for auto-send'}
                  </div>
                </div>
                <button className="hv" onClick={toggleAuto} style={{
                  background:autoOn?`${C.red}20`:`${C.green}20`,
                  border:`1px solid ${autoOn?C.red:C.green}`,
                  color:autoOn?C.red:C.green,
                  padding:'10px 20px',borderRadius:4,fontSize:12,letterSpacing:1,cursor:'pointer',fontFamily:"'Bebas Neue',sans-serif",
                }}>{autoOn?'⏹ STOP':'▶ START'}</button>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:11}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>MIN CONVICTION TO ALERT</div>
                  <select value={minScore} onChange={e=>setMinScore(Number(e.target.value))} style={iSt}>
                    {[60,70,75,80,85,90,95].map(v=><option key={v} value={v}>{v}% and above</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>SCAN FREQUENCY</div>
                  <select value={scanFreq} onChange={e=>{
                    const freq=Number(e.target.value)
                    setScanFreq(freq)
                    if(autoOn){
                      clearInterval(autoRef.current)
                      autoRef.current=setInterval(runAutoScan,freq*60*1000)
                      setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ⏱ Frequency updated to every ${freq} min`,...p.slice(0,99)])
                    }
                  }} style={iSt}>
                    {[1,2,3,5,10,15,20,30,60].map(v=><option key={v} value={v}>Every {v} {v===1?'minute':'minutes'}</option>)}
                  </select>
                  <div style={{fontSize:9,color:autoOn?C.green:C.dim,marginTop:3}}>
                    {autoOn?`🟢 Running — next scan in ~${scanFreq} min`:'Start scanner to activate'}
                  </div>
                </div>
              </div>

              <div style={{marginBottom:10}}>
                <Field label="Watchlist — blank = full SP500 pool (20 tickers)" value={watchlist} onChange={setWatchlist} placeholder="NVDA,AAPL,MSFT,SPY — or leave blank"/>
              </div>

              {/* Last alert */}
              {lastAlert && (
                <div style={{background:'#030f06',border:`1px solid ${C.green}50`,borderRadius:6,padding:12,marginBottom:10}}>
                  <Lbl color={C.green}>🚀 LATEST HIGH CONVICTION ALERT</Lbl>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8}}>
                    <div>
                      <div style={{display:'flex',gap:9,alignItems:'center',flexWrap:'wrap',marginBottom:4}}>
                        <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,color:C.green,letterSpacing:2}}>${lastAlert.ticker}</span>
                        <span style={{fontSize:12,color:'#c8d8e8'}}>{lastAlert.tradeType} {lastAlert.strikeStr}</span>
                        <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.green}}>{lastAlert.score}%</span>
                      </div>
                      <div style={{fontSize:11,color:C.dim}}>Entry: {lastAlert.entry} · Target: {lastAlert.target} · Stop: {lastAlert.stop}</div>
                      <div style={{fontSize:11,color:'#3a6a7a',marginTop:2}}>Bid: {lastAlert.bid} | Ask: {lastAlert.ask} | IV: {lastAlert.iv}</div>
                    </div>
                    <div style={{display:'flex',flexDirection:'column',gap:6}}>
                      <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildScanAlert(lastAlert));setAlertCopied(true);setTimeout(()=>setAlertCopied(false),2000)}} style={{background:`${C.green}25`,border:`1px solid ${C.green}`,color:C.green,padding:'8px 14px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>
                        {alertCopied?'✅ COPIED':'📋 COPY ALERT'}
                      </button>
                      {tgToken&&tgChatId&&(
                        <button className="hv" onClick={async()=>{await sendTelegram(buildScanAlert(lastAlert),tgToken,tgChatId);setTgStatus('✅ Sent!');setTimeout(()=>setTgStatus(''),3000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 14px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>📤 RESEND TG</button>
                      )}
                    </div>
                  </div>
                  {(lastAlert.reasons||[]).length>0 && (
                    <div style={{display:'flex',gap:5,flexWrap:'wrap',marginTop:7}}>
                      {lastAlert.reasons.map((r,i)=><span key={i} style={{fontSize:10,color:C.green,background:`${C.green}10`,padding:'2px 7px',borderRadius:3}}>✓ {r}</span>)}
                    </div>
                  )}
                  {tgStatus && <div style={{fontSize:11,color:C.green,marginTop:5}}>{tgStatus}</div>}
                </div>
              )}

              {/* Scanner log */}
              {autoLog.length>0 && (
                <div style={{background:'#02080e',borderRadius:5,padding:9,maxHeight:170,overflowY:'auto'}}>
                  <Lbl>Scanner Log</Lbl>
                  {autoLog.map((l,i) => (
                    <div key={i} style={{fontSize:11,color:l.includes('🚀')?C.green:l.includes('❌')?C.red:'#2a5a6a',fontFamily:'monospace',lineHeight:1.8}}>{l}</div>
                  ))}
                </div>
              )}
            </Card>

          </div>
        )}

      </div>
    </div>
  )
}
