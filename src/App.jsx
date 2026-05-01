import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Safe localStorage helper ─────────────────────────────────────────────────
const ls = (key, fallback='') => {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  green:'#00ff88', blue:'#00c8ff', orange:'#ff9500',
  red:'#ff4466',   dim:'#4a7a8a',  card:'#0d1a26',
  bg:'#090e14',    border:'#1a2e3e',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const autoStep = p => p<25?.5:p<50?1:p<100?2:p<250?5:p<500?10:p<1000?20:50
const fmtP   = n => n==null?'—':'$'+parseFloat(n).toFixed(2)
const fmtPct = n => n==null?'—':(parseFloat(n)*100).toFixed(1)+'%'
const safe   = v => v==null?'—':typeof v==='object'?JSON.stringify(v):String(v)

// ─── Module-level constants ───────────────────────────────────────────────────
const TF_CONFIG = {
  'Quick (5–14 DTE)': {
    minDTE:5,   maxDTE:14,  strikePct:1.02, profitTarget:0.50, stopLoss:0.50,
    label:'Quick Play', badge:'⚡', color:C.green,
    desc:'5–14 DTE · Fast momentum plays · 50% profit target',
  },
  'Swing (21–45 DTE)': {
    minDTE:21,  maxDTE:45,  strikePct:1.02, profitTarget:0.80, stopLoss:0.50,
    label:'Swing Trade', badge:'📈', color:C.blue,
    desc:'21–45 DTE · Directional swing · 80% profit target',
  },
  'LEAP (90–180 DTE)': {
    minDTE:90,  maxDTE:180, strikePct:1.05, profitTarget:1.00, stopLoss:0.40,
    label:'LEAP Option', badge:'🏔️', color:C.orange,
    desc:'90–180 DTE · Trend plays · 100% profit target',
  },
  'Deep LEAP (180–365 DTE)': {
    minDTE:180, maxDTE:365, strikePct:1.08, profitTarget:1.50, stopLoss:0.35,
    label:'Deep LEAP', badge:'🚀', color:C.red,
    desc:'180–365 DTE · Long conviction · 150% profit target',
  },
}

// Pick the best expiry date within a DTE window.
// Falls back to the closest available if no exact match in range.
const pickExpiry = (dates, minDTE, maxDTE) => {
  const now = new Date(); now.setHours(0,0,0,0)
  const withDTE = dates.map(d => {
    const exp = new Date(d+'T12:00:00')
    const dte = Math.round((exp-now)/(1000*60*60*24))
    return {date:d, dte}
  }).filter(x=>x.dte>0)
  // Ideal: first expiry inside the DTE window
  const inRange = withDTE.filter(x=>x.dte>=minDTE && x.dte<=maxDTE)
  if (inRange.length) return inRange[0].date
  // Fallback: closest expiry to the midpoint of the window
  const mid=(minDTE+maxDTE)/2
  return withDTE.reduce((best,x)=>Math.abs(x.dte-mid)<Math.abs(best.dte-mid)?x:best, withDTE[0]).date
}

const FUT_SYMBOLS = {
  // Primary is the Tradier-reliable symbol. SPX/NDX are the real index levels (≈ /ES /NQ)
  ES:  { name:'SPX — S&P 500 Index',     primary:'SPX',  fallback:'$SPX.X', chain:'SPX',  display:'SPX' },
  NQ:  { name:'NDX — Nasdaq 100 Index',  primary:'NDX',  fallback:'$NDX.X', chain:'NDX',  display:'NDX' },
  YM:  { name:'DJX — Dow Jones Index',   primary:'DJX',  fallback:'$DJI',   chain:'DJX',  display:'DJX' },
  RTY: { name:'RUT — Russell 2000',      primary:'RUT',  fallback:'$RUT.X', chain:'RUT',  display:'RUT' },
  CL:  { name:'/CL — Crude Oil (USO)',   primary:'USO',  fallback:'USO',    chain:'USO',  display:'USO' },
  GC:  { name:'/GC — Gold (GLD)',        primary:'GLD',  fallback:'GLD',    chain:'GLD',  display:'GLD' },
}

// Full S&P 500 constituent list
const SP500 = [
  'AAPL','MSFT','NVDA','AVGO','META','ORCL','CRM','AMD','INTC','QCOM',
  'TXN','AMAT','LRCX','KLAC','MCHP','CDNS','SNPS','ADI','MRVL','FTNT',
  'PANW','CRWD','DDOG','SNOW','MDB','ZS','NET','OKTA','TWLO','DOCN',
  'ADBE','NOW','WDAY','ANSS','PTC','TYL','EPAM','CTSH','ACN','IBM',
  'HPE','HPQ','STX','WDC','NTAP','PSTG','DELL','SMCI',
  'GOOGL','GOOG','NFLX','DIS','CMCSA','T','VZ','CHTR','TMUS',
  'PARA','WBD','FOXA','FOX','OMC','IPG','TTWO','EA','RBLX',
  'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TJX','BKNG','CMG',
  'YUM','DG','DLTR','ROST','BBY','ETSY','EBAY','ABNB','LYFT','UBER',
  'F','GM','RIVN','LCID','APTV','MGA','BWA',
  'WMT','COST','PG','KO','PEP','PM','MO','MDLZ','KHC',
  'GIS','K','CPB','SJM','HRL','CAG','MKC','CHD','CLX','KMB',
  'JPM','BAC','WFC','GS','MS','C','BLK','SCHW','AXP','V','MA',
  'COF','USB','TFC','PNC','FITB','HBAN','KEY','RF','CFG','MTB',
  'STT','BK','NTRS','ICE','CME','CBOE','NDAQ','MCO','SPGI','FDS',
  'AFL','MET','PRU','AIG','TRV','ALL','CB','MMC','WTW','AON',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','ABT','TMO','DHR','BMY',
  'AMGN','GILD','REGN','VRTX','BIIB','MRNA','BNTX','ILMN','IQV',
  'CVS','CI','HUM','CNC','MOH','ELV','DGX','LH','HOLX','BAX',
  'BSX','EW','SYK','MDT','BDX','ZBH','STE','HSIC','RMD','IDXX',
  'CAT','BA','HON','GE','LMT','RTX','NOC','GD','HII',
  'UPS','FDX','DAL','UAL','AAL','LUV','ALK','EXPD','XPO','JBHT',
  'DE','EMR','ETN','ROK','PH','ITW','DOV','AME','NDSN','GWW',
  'URI','WAB','TT','CARR','OTIS','JCI','GNRC',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','HAL',
  'DVN','FANG','PXD','APA','HES','MRO','OKE','KMI','WMB','ET',
  'LIN','APD','SHW','ECL','PPG','NEM','GOLD','FCX','NUE','STLD',
  'RS','CF','MOS','ALB','EMN','CE','IFF','FMC','RPM','SEE',
  'AMT','PLD','CCI','EQIX','DLR','PSA','EQR','AVB','VTR','WELL',
  'ARE','BXP','SLG','KIM','REG','FRT','SPG','MAC','SKT','O',
  'NEE','DUK','SO','AEP','EXC','SRE','PCG','ED','EIX','XEL',
  'WEC','ETR','PPL','CMS','LNT','PNW','OGE','EVRG','NI',
  'SPY','QQQ','IWM','DIA','GLD','SLV','USO','TLT','HYG','LQD',
  'XLF','XLE','XLK','XLV','XLI','XLU','XLB','XLRE','XLP','XLY',
  'COIN','MSTR','PLTR','SOFI','HOOD','UPST','AFRM',
  'CVNA','IONQ','ARRY','ENPH','SEDG','RUN','FSLR','NOVA',
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

// ─── Shared UI ────────────────────────────────────────────────────────────────
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
    <div style={{background:C.card,border:`1px solid ${color||C.border}`,borderRadius:6,padding:14,...style}}>
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
      padding:'7px 14px',borderRadius:4,fontSize:11,letterSpacing:.8,cursor:'pointer',
      border:`1px solid ${active?color:C.border}`,color:active?color:C.dim,
      background:active?`${color}18`:'transparent',
    }}>{label}</button>
  )
}

// ─── P&L Sparkline ────────────────────────────────────────────────────────────
function PnLChart({ trades }) {
  const closed = [...trades].filter(t=>t.status!=='Open').reverse()
  if (closed.length < 2) return (
    <div style={{textAlign:'center',padding:'20px 0',fontSize:11,color:C.dim,border:`1px dashed ${C.border}`,borderRadius:6}}>
      Log 2+ closed trades to see equity curve
    </div>
  )
  const W=340, H=70
  const cumPnL = closed.reduce((acc,t)=>{
    const prev = acc[acc.length-1]?.y||0
    acc.push({y: prev+parseFloat(t.pnl||0), t: t.ticker})
    return acc
  },[])
  const vals = cumPnL.map(p=>p.y)
  const minV = Math.min(0,...vals), maxV = Math.max(0,...vals)
  const range = maxV-minV||1
  const toY = v => H - ((v-minV)/range)*H*0.85 - H*0.05
  const pts = cumPnL.map((p,i)=>`${(i/(cumPnL.length-1))*W},${toY(p.y)}`).join(' ')
  const lastY = cumPnL[cumPnL.length-1].y
  const lineColor = lastY>=0?C.green:C.red
  const zeroY = toY(0)
  return (
    <div style={{position:'relative'}}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,display:'block'}}>
        <defs>
          <linearGradient id="pgrd" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25"/>
            <stop offset="100%" stopColor={lineColor} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={C.border} strokeWidth={1} strokeDasharray="4,4"/>
        <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#pgrd)"/>
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.8}/>
        <circle cx={(cumPnL.length-1)/(cumPnL.length-1)*W} cy={toY(lastY)} r={3} fill={lineColor}/>
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:9,color:C.dim,marginTop:3,letterSpacing:.5}}>
        <span>{closed[0]?.date||closed[0]?.ticker||''}</span>
        <span>{closed[closed.length-1]?.date||closed[closed.length-1]?.ticker||''}</span>
      </div>
    </div>
  )
}

// ─── Tradier API proxy ────────────────────────────────────────────────────────
async function tradierGet(path, token, mode) {
  const res = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, {
    headers:{'x-tradier-token':token,'x-tradier-mode':mode},
  })
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${await res.text().catch(()=>'')}`)
  return res.json()
}

async function sendTelegram(message, token, chatId) {
  const res = await fetch('/api/telegram', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message,token,chat_id:chatId}),
  })
  return res.json()
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {

  // ── main tab & tools panel ──
  const [tab,        setTab]        = useState('dash')
  const [showTools,  setShowTools]  = useState(false)
  const [toolsTab,   setToolsTab]   = useState('settings')

  // ── settings ──
  const [anthropicKey,  setAnthropicKey]  = useState(()=>ls('anthropicKey'))
  const [tradierToken, setTradierToken] = useState(()=>ls('tradierToken'))
  const [tradierMode,  setTradierMode]  = useState(()=>ls('tradierMode','production'))
  const [tgToken,      setTgToken]      = useState(()=>ls('tgToken'))
  const [tgChatId,     setTgChatId]     = useState(()=>ls('tgChatId'))
  const [watchlist,    setWatchlist]    = useState(()=>ls('watchlist','NVDA,AAPL,MSFT,SPY,TSLA'))
  const [minScore,     setMinScore]     = useState(()=>Number(ls('minScore','80')))
  const [scanFreq,     setScanFreq]     = useState(()=>Number(ls('scanFreq','5')))
  const [tgStatus,     setTgStatus]     = useState('')

  useEffect(()=>{try{localStorage.setItem('anthropicKey', anthropicKey)}catch{}},[anthropicKey])
  useEffect(()=>{try{localStorage.setItem('tradierToken',tradierToken)}catch{}},[tradierToken])
  useEffect(()=>{try{localStorage.setItem('tradierMode', tradierMode)} catch{}},[tradierMode])
  useEffect(()=>{try{localStorage.setItem('tgToken',     tgToken)}     catch{}},[tgToken])
  useEffect(()=>{try{localStorage.setItem('tgChatId',    tgChatId)}    catch{}},[tgChatId])
  useEffect(()=>{try{localStorage.setItem('watchlist',   watchlist)}   catch{}},[watchlist])
  useEffect(()=>{try{localStorage.setItem('minScore',    String(minScore))}catch{}},[minScore])
  useEffect(()=>{try{localStorage.setItem('scanFreq',    String(scanFreq))}catch{}},[scanFreq])

  // ── price bar ──
  const [esBar, setEsBar] = useState(null)
  const [nqBar, setNqBar] = useState(null)
  const [barLoading, setBarLoading] = useState(false)

  // ── index alerts & conviction ──
  const [indexAlerts,        setIndexAlerts]        = useState([])
  const [indexAlertsLoading, setIndexAlertsLoading] = useState(false)
  const [marketConviction,   setMarketConviction]   = useState(null)
  const [morningBrief,       setMorningBrief]       = useState('')
  const [briefLoading,       setBriefLoading]       = useState(false)

  // ── checklist ──
  const [checked, setChecked] = useState({})
  const clScore = Math.round(Object.values(checked).filter(Boolean).length/CHECKLIST.length*100)
  const clColor = clScore>=80?C.green:clScore>=60?C.orange:C.red

  // ── alert builder ──
  const [alert, setAlert] = useState({
    type:'Call',ticker:'',expiry:'',strike:'',entry:'',
    target:'',stop:'',size:'1–2 contracts',thesis:'',catalyst:'',flow:'',
  })
  const [copied, setCopied] = useState(false)

  // ── journal ──
  const [trades,   setTrades]   = useState(()=>{try{return JSON.parse(ls('trades','[]'))}catch{return[]}})
  const [showAdd,  setShowAdd]  = useState(false)
  const [jFilter,  setJFilter]  = useState('All')
  const [newTrade, setNewTrade] = useState({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:''})
  useEffect(()=>{try{localStorage.setItem('trades',JSON.stringify(trades))}catch{}},[trades])

  const jStats = (()=>{
    const closed=trades.filter(t=>t.status!=='Open')
    const wins=closed.filter(t=>parseFloat(t.pnl)>0)
    const losses=closed.filter(t=>parseFloat(t.pnl)<0)
    return {
      pnl:   closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0),
      wr:    closed.length?Math.round(wins.length/closed.length*100):0,
      aw:    wins.length?wins.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/wins.length:0,
      al:    losses.length?Math.abs(losses.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/losses.length):0,
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
  const autoRef    = useRef(null)
  const scanTFRef  = useRef(scanTF)   // always holds live scanTF — avoids stale closure in interval
  useEffect(()=>{ scanTFRef.current = scanTF },[scanTF])

  // ── futures (tools panel) ──
  const [futSym,     setFutSym]     = useState('ES')
  const [futData,    setFutData]    = useState(null)
  const [futLoading, setFutLoading] = useState(false)
  const [futErr,     setFutErr]     = useState('')

  // ─── Tradier helpers ──────────────────────────────────────────────────────
  const tGet     = useCallback((path)=>tradierGet(path,tradierToken,tradierMode),[tradierToken,tradierMode])
  const getQuote    = async t=>{const d=await tGet(`/markets/quotes?symbols=${t}&greeks=false`);return d?.quotes?.quote||null}
  const getExpiries = async t=>{const d=await tGet(`/markets/options/expirations?symbol=${t}&includeAllRoots=false`);return d?.expirations?.date||[]}
  const getChain    = async(t,e)=>{const d=await tGet(`/markets/options/chains?symbol=${t}&expiration=${e}&greeks=true`);return d?.options?.option||[]}

  // ─── Price bar fetch ──────────────────────────────────────────────────────
  const fetchPriceBar = useCallback(async()=>{
    setBarLoading(true)
    const tryQuote = async symbols => {
      for (const sym of symbols) {
        try {
          const q = await getQuote(sym)
          const p = parseFloat(q?.last||q?.prevclose||0)
          if (p) return { price:p, chgPct:parseFloat(q.change_percentage||0), chg:parseFloat(q.change||0), sym }
        } catch {}
      }
      return null
    }
    // SPX/NDX are the primary symbols — direct Tradier index quotes
    const [es, nq] = await Promise.all([
      tryQuote(['SPX','$SPX.X','SPY']),
      tryQuote(['NDX','$NDX.X','QQQ']),
    ])
    if (es) setEsBar({...es, label:'SPX'})
    if (nq) setNqBar({...nq, label:'NDX'})
    // Update market conviction whenever prices refresh
    if (es) {
      const spxChg = es.chgPct
      const ndxChg = nq?.chgPct || spxChg
      const volR   = 1 // volume not in bar data — neutral
      let bull = 50
      if (spxChg > 1.0) bull += 22
      else if (spxChg > 0.5) bull += 14
      else if (spxChg > 0.1) bull += 6
      else if (spxChg < -1.0) bull -= 22
      else if (spxChg < -0.5) bull -= 14
      else if (spxChg < -0.1) bull -= 6
      if (ndxChg > 0 && spxChg > 0) bull += 8
      else if (ndxChg < 0 && spxChg < 0) bull -= 8
      bull = Math.min(94, Math.max(6, bull))
      const dir = bull >= 62 ? 'BULLISH' : bull <= 38 ? 'BEARISH' : 'NEUTRAL'
      setMarketConviction({ score: bull, direction: dir, spxChg, ndxChg,
        color: dir==='BULLISH'?C.green:dir==='BEARISH'?C.red:C.orange })
    }
    setBarLoading(false)
  },[tradierToken,tradierMode])

  useEffect(()=>{ fetchPriceBar() },[]) // fetch on mount

  // ─── Single ticker scan ───────────────────────────────────────────────────
  const runScan = async()=>{
    if (!scanTicker.trim()) return
    const log=[]; const dbg=m=>{log.push(m);setDebugLog([...log])}
    setScanning(true);setScanResult(null);setScanErr('');setDebugLog([])
    const ticker=scanTicker.toUpperCase()
    try {
      dbg(`1. Fetching live quote for $${ticker}...`)
      const quote=await getQuote(ticker)
      if (!quote) throw new Error('No quote — check ticker and token')
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')
      dbg(`   ✓ $${ticker} = $${price.toFixed(2)} | chg: ${parseFloat(quote.change_percentage||0).toFixed(2)}%`)

      dbg('2. Fetching expiry dates...')
      const expDates=await getExpiries(ticker)
      if (!expDates.length) throw new Error('No expiry dates found')
      const tfCfg=TF_CONFIG[scanTF]||TF_CONFIG['Swing (21–45 DTE)']
      const expiryRaw=pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
      const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      dbg(`   ✓ Expiry: ${expiryRaw} → ${expiryDisplay}`)

      dbg('3. Fetching options chain...')
      const chain=await getChain(ticker,expiryRaw)
      if (!chain.length) throw new Error('Empty options chain')
      dbg(`   ✓ ${chain.length} contracts`)

      const chgPct=parseFloat(quote.change_percentage||0)
      const bearish=scanType==='Put'||scanType==='Put Spread'||(scanType==='Any'&&chgPct<-0.5)
      const optType=bearish?'put':'call'
      const tradeType=scanType==='Any'?(bearish?'Put':'Call'):scanType

      const step=autoStep(price)
      const strikePct=bearish?(2-tfCfg.strikePct):tfCfg.strikePct
      const tgtStrike=Math.round(price*strikePct/step)*step
      const side=chain.filter(o=>o.option_type===optType)
      if (!side.length) throw new Error(`No ${optType} contracts found`)
      const best=side.reduce((a,b)=>Math.abs(b.strike-tgtStrike)<Math.abs(a.strike-tgtStrike)?b:a)
      const bid=parseFloat(best.bid||0)
      const ask=parseFloat(best.ask||0)
      const mid=(bid+ask)/2
      if (mid===0) throw new Error('Bid/ask both $0 — no liquidity')
      const iv=best.greeks?.mid_iv||best.implied_volatility||0
      const delta=best.greeks?.delta||null
      const theta=best.greeks?.theta||null
      dbg(`   ✓ Strike: $${best.strike}${optType==='call'?'C':'P'} | Bid: ${fmtP(bid)} | Ask: ${fmtP(ask)} | Mid: ${fmtP(mid)}`)
      dbg(`   ✓ IV: ${fmtPct(iv)} | Delta: ${delta?.toFixed(3)||'—'} | Theta: ${theta?.toFixed(3)||'—'}`)

      const entry1=(mid*0.95).toFixed(2)
      const entry2=(mid*1.05).toFixed(2)
      const target=(mid*(1+tfCfg.profitTarget)).toFixed(2)
      const stop=(mid*(1-tfCfg.stopLoss)).toFixed(2)
      dbg(`   ✓ Entry: $${entry1}–$${entry2} | Target: $${target} | Stop: $${stop}`)

      const vol=quote.volume||0,avgVol=quote.average_volume||vol
      const volRatio=vol/(avgVol||1)
      let score=50;const reasons=[],warnings=[]
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
        ticker,tradeType,score,
        expiryDisplay,expiryRaw,
        strikeStr:`$${best.strike}${optType==='call'?'C':'P'}`,
        entry:`$${entry1} – $${entry2}`,
        target:`$${target} (+${(tfCfg.profitTarget*100).toFixed(0)}%)`,
        stop:`$${stop} (-${(tfCfg.stopLoss*100).toFixed(0)}%)`,
        grade:score>=80?'A':score>=65?'B':'C',
        confidence:score>=80?'High':score>=65?'Medium':'Low',
        price:fmtP(price),bid:fmtP(bid),ask:fmtP(ask),mid:fmtP(mid),
        iv:fmtPct(iv),
        delta:delta?delta.toFixed(3):'—',
        theta:theta?theta.toFixed(3):'—',
        volume:best.volume||0,
        oi:best.open_interest||0,
        chgPct:chgPct.toFixed(2)+'%',
        volRatio:volRatio.toFixed(1)+'x',
        reasons,warnings,
        tfLabel:tfCfg.label,tfBadge:tfCfg.badge,tfColor:tfCfg.color,
        source:`Tradier ${tradierMode}`,
      })
    } catch(e) {
      setScanErr('❌ '+e.message)
      dbg('ERROR: '+e.message)
    }
    setScanning(false)
  }

  // ─── Futures fetch ────────────────────────────────────────────────────────
  const fetchFutures = async sym=>{
    setFutLoading(true);setFutErr('');setFutData(null)
    const cfg=FUT_SYMBOLS[sym]
    try {
      // Use primary symbol directly (SPX, NDX, etc.)
      let quote = null, priceSource = cfg.display, usingFutures = false
      for (const sym of [cfg.primary, cfg.fallback]) {
        try {
          const q = await getQuote(sym)
          const p = parseFloat(q?.last||q?.prevclose||0)
          if (p) { quote=q; priceSource=sym; break }
        } catch {}
      }
      if (!quote) throw new Error(
        `No quote for ${cfg.primary}. Check your Tradier token in ⚙ Settings.`
      )
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')

      const expDates=await getExpiries(cfg.chain)
      const expiry=expDates[1]||expDates[0]
      let topCalls=[],topPuts=[],chainLen=0,tradeSetups=[]

      if (expiry) {
        const chain=await getChain(cfg.chain,expiry)
        chainLen=chain.length
        const calls=chain.filter(o=>o.option_type==='call').sort((a,b)=>(b.open_interest||0)-(a.open_interest||0))
        const puts=chain.filter(o=>o.option_type==='put').sort((a,b)=>(b.open_interest||0)-(a.open_interest||0))
        topCalls=calls.slice(0,5).map(o=>({
          strike:o.strike,oi:o.open_interest||0,vol:o.volume||0,
          bid:o.bid||0,ask:o.ask||0,mid:((o.bid||0)+(o.ask||0))/2,
          iv:o.greeks?.mid_iv?(o.greeks.mid_iv*100).toFixed(1)+'%':'—',
          delta:o.greeks?.delta?o.greeks.delta.toFixed(3):'—',
        }))
        topPuts=puts.slice(0,5).map(o=>({
          strike:o.strike,oi:o.open_interest||0,vol:o.volume||0,
          bid:o.bid||0,ask:o.ask||0,mid:((o.bid||0)+(o.ask||0))/2,
          iv:o.greeks?.mid_iv?(o.greeks.mid_iv*100).toFixed(1)+'%':'—',
          delta:o.greeks?.delta?o.greeks.delta.toFixed(3):'—',
        }))
        const expiryDisplay=new Date(expiry+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
        const chgPct_=parseFloat(quote.change_percentage||0)
        const bias_=chgPct_>0.3?'bull':chgPct_<-0.3?'bear':'neutral'
        const step_=autoStep(price)
        const bestCall_=topCalls[0]?chain.filter(o=>o.option_type==='call').reduce((a,b)=>Math.abs(b.strike-Math.round(price*1.01/step_)*step_)<Math.abs(a.strike-Math.round(price*1.01/step_)*step_)?b:a):null
        const bestPut_=topPuts[0]?chain.filter(o=>o.option_type==='put').reduce((a,b)=>Math.abs(b.strike-Math.round(price*0.99/step_)*step_)<Math.abs(a.strike-Math.round(price*0.99/step_)*step_)?b:a):null
        if (bestCall_) {
          const mid=((bestCall_.bid||0)+(bestCall_.ask||0))/2
          if (mid>0) tradeSetups.push({
            type:'Call',strike:`$${bestCall_.strike}C`,expiry:expiryDisplay,
            entry:fmtP(mid*0.95)+' – '+fmtP(mid*1.05),target:fmtP(mid*1.8),stop:fmtP(mid*0.5),
            iv:bestCall_.greeks?.mid_iv?(bestCall_.greeks.mid_iv*100).toFixed(1)+'%':'—',
            delta:bestCall_.greeks?.delta?bestCall_.greeks.delta.toFixed(3):'—',
            oi:bestCall_.open_interest||0,conviction:bias_==='bull'?'High':'Medium',color:C.green,
          })
        }
        if (bestPut_) {
          const mid=((bestPut_.bid||0)+(bestPut_.ask||0))/2
          if (mid>0) tradeSetups.push({
            type:'Put',strike:`$${bestPut_.strike}P`,expiry:expiryDisplay,
            entry:fmtP(mid*0.95)+' – '+fmtP(mid*1.05),target:fmtP(mid*1.8),stop:fmtP(mid*0.5),
            iv:bestPut_.greeks?.mid_iv?(bestPut_.greeks.mid_iv*100).toFixed(1)+'%':'—',
            delta:bestPut_.greeks?.delta?bestPut_.greeks.delta.toFixed(3):'—',
            oi:bestPut_.open_interest||0,conviction:bias_==='bear'?'High':'Medium',color:C.red,
          })
        }
      }

      const chgPct=parseFloat(quote.change_percentage||0)
      const chg=parseFloat(quote.change||0)
      const hi=parseFloat(quote.high||price)
      const lo=parseFloat(quote.low||price)
      const bias=chgPct>0.3?'Bullish':chgPct<-0.3?'Bearish':'Neutral'
      const biasColor=bias==='Bullish'?C.green:bias==='Bearish'?C.red:C.orange
      const resistance=[...new Set([...topCalls.map(s=>s.strike),parseFloat(hi.toFixed(2))])].filter(l=>l>price).sort((a,b)=>a-b).slice(0,3)
      const support=[...new Set([...topPuts.map(s=>s.strike),parseFloat(lo.toFixed(2))])].filter(l=>l<price).sort((a,b)=>b-a).slice(0,3)

      setFutData({
        sym,cfg,price,chg,chgPct,hi,lo,bias,biasColor,
        hi52:parseFloat(quote.week_52_high||price),
        lo52:parseFloat(quote.week_52_low||price),
        vol:quote.volume||0,
        open:parseFloat(quote.open||price),
        resistance,support,topCalls,topPuts,chainLen,
        tradeSetups,expiry,priceSource,usingFutures,
        fetchedAt:new Date().toLocaleTimeString(),
      })
    } catch(e) {
      setFutErr('❌ '+e.message)
    }
    setFutLoading(false)
  }

  // ─── Alert builder helpers ────────────────────────────────────────────────
  const buildTgAlert = a=>{
    const em={Call:'🟢📈',Put:'🔴📉','Call Spread':'🟢📐','Put Spread':'🔴📐','Iron Condor':'🦅⚖️',Strangle:'🔀⚖️'}
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

  const buildScanAlert = r=>`${r.tradeType==='Put'||r.tradeType==='Put Spread'?'🔴📉':'🟢📈'} *${r.tradeType.toUpperCase()} ALERT — $${r.ticker}*

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

  const pushToAlert = r=>{
    setAlert(p=>({...p,
      ticker:r.ticker||p.ticker,type:r.tradeType||p.type,
      expiry:r.expiryDisplay||p.expiry,strike:r.strikeStr||p.strike,
      entry:r.entry||p.entry,target:r.target||p.target,stop:r.stop||p.stop,
    }))
    setToolsTab('alert')
    setShowTools(true)
  }

  // ─── Auto scanner ─────────────────────────────────────────────────────────
  const scanOneTicker = useCallback(async (ticker, tf='Swing (21–45 DTE)')=>{
    const tfCfg2 = TF_CONFIG[tf] || TF_CONFIG['Swing (21–45 DTE)']
    try {
      const quote=await getQuote(ticker)
      if (!quote) return null
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) return null
      const expDates=await getExpiries(ticker)
      if (!expDates.length) return null
      const expiryRaw=pickExpiry(expDates, tfCfg2.minDTE, tfCfg2.maxDTE)
      const chain=await getChain(ticker,expiryRaw)
      if (!chain.length) return null
      const chgPct=parseFloat(quote.change_percentage||0)
      const optType=chgPct>=0?'call':'put'
      const step=autoStep(price)
      const tgt=optType==='call'?Math.round(price*1.02/step)*step:Math.round(price*0.98/step)*step
      const side=chain.filter(o=>o.option_type===optType)
      if (!side.length) return null
      const best=side.reduce((a,b)=>Math.abs(b.strike-tgt)<Math.abs(a.strike-tgt)?b:a)
      const bid=parseFloat(best.bid||0),ask=parseFloat(best.ask||0),mid=(bid+ask)/2
      if (mid===0) return null
      const iv=best.greeks?.mid_iv||0,delta=best.greeks?.delta||null
      const vol=quote.volume||0,avg=quote.average_volume||vol
      const volRatio=vol/(avg||1)
      let score=50;const reasons=[],warnings=[]
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
        ticker,score,tradeType:optType==='call'?'Call':'Put',
        price:fmtP(price),bid:fmtP(bid),ask:fmtP(ask),mid:fmtP(mid),
        iv:fmtPct(iv),delta:delta?delta.toFixed(3):'—',
        volume:best.volume||0,oi:best.open_interest||0,
        strikeStr:`$${best.strike}${optType==='call'?'C':'P'}`,
        expiryDisplay,
        entry:`$${(mid*0.95).toFixed(2)} – $${(mid*1.05).toFixed(2)}`,
        target:`$${(mid*(1+tfCfg2.profitTarget)).toFixed(2)} (+${(tfCfg2.profitTarget*100).toFixed(0)}%)`,
        stop:`$${(mid*(1-tfCfg2.stopLoss)).toFixed(2)} (-${(tfCfg2.stopLoss*100).toFixed(0)}%)`,
        tfLabel:tfCfg2.label, tfBadge:tfCfg2.badge, tfColor:tfCfg2.color,
        grade:score>=80?'A':score>=65?'B':'C',
        chgPct:chgPct.toFixed(2)+'%',
        reasons,warnings,
      }
    } catch { return null }
  },[tradierToken,tradierMode])

  const runAutoScan = useCallback(async()=>{
    if (!tradierToken) return
    const activeTF = scanTFRef.current  // read live value — not stale closure
    const tfCfgNow = TF_CONFIG[activeTF]||TF_CONFIG['Swing (21–45 DTE)']
    const list=watchlist.split(',').map(t=>t.trim().toUpperCase()).filter(Boolean)
    const shuffle=arr=>[...arr].sort(()=>Math.random()-.5)
    const tickers=list.length?list:shuffle(SP500)
    const ts=new Date().toLocaleTimeString()
    setAutoLog(p=>[`[${ts}] ▶ Scanning ${tickers.length} tickers · ${tfCfgNow.badge} ${tfCfgNow.label} (${activeTF})`,...p.slice(0,99)])
    for (const ticker of tickers) {
      const r=await scanOneTicker(ticker, activeTF)
      const ts2=new Date().toLocaleTimeString()
      if (!r){setAutoLog(p=>[`[${ts2}] $${ticker}: no data`,...p.slice(0,99)]);continue}
      setAutoLog(p=>[`[${ts2}] $${ticker}: ${r.score}% ${r.tradeType} ${r.strikeStr} mid:${r.mid}`,...p.slice(0,99)])
      if (r.score>=minScore) {
        setLastAlert(r)
        if (tgToken&&tgChatId) {
          const res=await sendTelegram(buildScanAlert(r),tgToken,tgChatId)
          setAutoLog(p=>[`[${ts2}] 🚀 ALERT $${ticker} ${r.score}% → TG: ${res.ok?'✅':'❌'+(res.description||'')}`,...p.slice(0,99)])
        } else {
          setAutoLog(p=>[`[${ts2}] 🚀 $${ticker} ${r.score}% hits threshold`,...p.slice(0,99)])
        }
      }
      await new Promise(res=>setTimeout(res,400))
    }
  },[tradierToken,tradierMode,watchlist,minScore,tgToken,tgChatId,scanOneTicker])

  const toggleAuto=()=>{
    if (autoOn) {
      clearInterval(autoRef.current)
      setAutoOn(false)
      const tfNow = scanTFRef.current
      const tfLabel = TF_CONFIG[tfNow]?.label||tfNow
      setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ◼ Stopped · was using ${tfLabel}`,...p.slice(0,99)])
    } else {
      // Re-read live scanTF so START always picks up whatever is currently selected
      const tfNow = scanTFRef.current
      const tfCfgNow = TF_CONFIG[tfNow]||TF_CONFIG['Swing (21–45 DTE)']
      setAutoOn(true)
      setAutoLog([
        `[${new Date().toLocaleTimeString()}] ▶ Started · ${tfCfgNow.badge} ${tfCfgNow.label}`,
        `[${new Date().toLocaleTimeString()}] DTE window: ${tfNow} · every ${scanFreq} min · ${minScore}%+ threshold`,
      ])
      runAutoScan()
      autoRef.current=setInterval(runAutoScan,scanFreq*60*1000)
    }
  }
  useEffect(()=>()=>clearInterval(autoRef.current),[])

  // ─── Journal helpers ──────────────────────────────────────────────────────
  const addTrade=()=>{
    if (!newTrade.ticker) return
    const t={...newTrade,id:Date.now()+'',date:newTrade.date||new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
    setTrades(p=>[t,...p])
    setNewTrade({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:''})
    setShowAdd(false)
  }
  const gradeCol=g=>g==='A'?C.green:g==='B'?C.orange:C.red

  // ─── Generate SPX/NDX index alerts across all timeframes ─────────────────
  const generateIndexAlerts = useCallback(async()=>{
    setIndexAlertsLoading(true); setIndexAlerts([])
    const results = []
    for (const sym of ['SPX','NDX']) {
      try {
        const quote = await getQuote(sym)
        if (!quote) continue
        const price = parseFloat(quote.last||quote.prevclose||0)
        if (!price) continue
        const expDates = await getExpiries(sym)
        if (!expDates.length) continue
        const chgPct = parseFloat(quote.change_percentage||0)

        for (const [tfKey, tfCfg] of Object.entries(TF_CONFIG)) {
          try {
            const expiryRaw = pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
            if (!expiryRaw) continue
            const chain = await getChain(sym, expiryRaw)
            if (!chain.length) continue

            // Determine bias from price action
            const bearish = chgPct < -0.2
            const optType = bearish ? 'put' : 'call'
            const step = autoStep(price)
            const tgtStrike = bearish
              ? Math.round(price*(2-tfCfg.strikePct)/step)*step
              : Math.round(price*tfCfg.strikePct/step)*step
            const side = chain.filter(o=>o.option_type===optType)
            if (!side.length) continue
            const best = side.reduce((a,b)=>Math.abs(b.strike-tgtStrike)<Math.abs(a.strike-tgtStrike)?b:a)
            const bid=parseFloat(best.bid||0), ask=parseFloat(best.ask||0), mid=(bid+ask)/2
            if (mid===0) continue
            const iv=best.greeks?.mid_iv||0, delta=best.greeks?.delta||null

            // Score — generous for indices (predictable trend vehicles)
            const vol=quote.volume||0, avg=quote.average_volume||vol
            const volRatio=vol/(avg||1)
            let score=52; const reasons=[],warnings=[]
            if(volRatio>=1.5){score+=14;reasons.push(`Volume ${volRatio.toFixed(1)}x avg`)}
            else if(volRatio<0.8){score-=8;warnings.push(`Low volume`)}
            if(Math.abs(chgPct)>=0.5){score+=12;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`)}
            else if(Math.abs(chgPct)>=0.2){score+=6}
            if(iv>=0.10&&iv<=0.40){score+=12;reasons.push(`IV ${(iv*100).toFixed(0)}% — tradeable`)}
            else if(iv>0.50){warnings.push(`Elevated IV ${(iv*100).toFixed(0)}%`)}
            if(delta&&Math.abs(delta)>=0.30&&Math.abs(delta)<=0.70){score+=10;reasons.push(`Delta ${delta.toFixed(2)}`)}
            // Bonus: both SPX + NDX moving together
            if(marketConviction&&((marketConviction.spxChg>0&&!bearish)||(marketConviction.spxChg<0&&bearish))){score+=8;reasons.push('Market aligned')}
            score=Math.min(96,Math.max(30,score))

            const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
            results.push({
              sym, tfKey, tfLabel:tfCfg.label, tfBadge:tfCfg.badge, tfColor:tfCfg.color,
              tradeType: optType==='call'?'Call':'Put',
              strikeStr:`$${best.strike}${optType==='call'?'C':'P'}`,
              expiryDisplay, score,
              grade:score>=90?'A+':score>=80?'A':score>=70?'B':'C',
              price:fmtP(price), bid:fmtP(bid), ask:fmtP(ask), mid:fmtP(mid),
              iv:fmtPct(iv), delta:delta?delta.toFixed(3):'—',
              entry:`$${(mid*0.95).toFixed(2)} – $${(mid*1.05).toFixed(2)}`,
              target:`$${(mid*(1+tfCfg.profitTarget)).toFixed(2)} (+${(tfCfg.profitTarget*100).toFixed(0)}%)`,
              stop:`$${(mid*(1-tfCfg.stopLoss)).toFixed(2)} (-${(tfCfg.stopLoss*100).toFixed(0)}%)`,
              reasons, warnings, chgPct:chgPct.toFixed(2)+'%',
            })
          } catch {}
        }
      } catch {}
    }
    results.sort((a,b)=>b.score-a.score)
    setIndexAlerts(results)
    setIndexAlertsLoading(false)
  },[tradierToken,tradierMode,marketConviction])

  // ─── Morning brief via Claude API ─────────────────────────────────────────
  const fetchMorningBrief = useCallback(async()=>{
    setBriefLoading(true); setMorningBrief('')
    try {
      const r = await fetch('/api/morning', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          spxPrice: esBar?.price?.toFixed(2),
          spxChange: esBar?.chgPct?.toFixed(2),
          ndxPrice: nqBar?.price?.toFixed(2),
          ndxChange: nqBar?.chgPct?.toFixed(2),
          apiKey: anthropicKey,
        })
      })
      // Read as text first — Vercel can return HTML error pages on server crashes
      const text = await r.text()
      let d
      try { d = JSON.parse(text) } catch {
        setMorningBrief('❌ Server returned non-JSON response:\n'+text.slice(0,300)+
          '\n\nThis usually means the /api/morning function crashed on Vercel.\n'+
          'Check Vercel → Deployments → Functions logs for details.')
        setBriefLoading(false); return
      }
      setMorningBrief(d.brief || ('❌ '+(d.error||'No content returned')))
    } catch(e) {
      setMorningBrief('❌ Fetch failed: '+e.message+'\n\nCheck that /api/morning.js is deployed.')
    }
    setBriefLoading(false)
  },[esBar,nqBar])

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{background:C.bg,minHeight:'100vh',fontFamily:"'IBM Plex Mono',monospace",color:'#c8d8e8',paddingBottom:68}}>
      <style>{`
        *{box-sizing:border-box}
        .hv{cursor:pointer;transition:opacity .15s}.hv:hover{opacity:.8}
        .si{animation:si .25s ease}@keyframes si{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .pulse{animation:pu 1.1s infinite}@keyframes pu{0%,100%{opacity:1}50%{opacity:.35}}
        input:focus,textarea:focus,select:focus{outline:none;border-color:#00ff88!important}
        select option{background:#0d1a26}
        .scanrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:5px}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0a1218}::-webkit-scrollbar-thumb{background:#1a3040;border-radius:2px}
      `}</style>

      {/* ═══════════════ STICKY HEADER ═══════════════════════════════════════ */}
      <div style={{position:'sticky',top:0,zIndex:100,background:C.bg,borderBottom:`1px solid ${C.border}`}}>

        {/* App title row */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px 9px'}}>
          <div style={{display:'flex',alignItems:'baseline',gap:8}}>
            <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,letterSpacing:3,color:C.green,lineHeight:1}}>OPTIONS EDGE</span>
            <span style={{fontSize:8,color:C.dim,letterSpacing:2}}>v3.0</span>
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {autoOn && (
              <span style={{fontSize:9,color:C.green,display:'flex',alignItems:'center',gap:4}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:C.green,display:'inline-block',boxShadow:`0 0 7px ${C.green}`}} className="pulse"/>
                AUTO
              </span>
            )}
            {tradierToken && <span style={{fontSize:9,color:C.dim,letterSpacing:1}}>{tradierMode.toUpperCase()}</span>}
            <button className="hv" onClick={()=>{setShowTools(p=>!p);if(!showTools)setToolsTab('settings')}} style={{background:showTools?`${C.green}18`:'transparent',border:`1px solid ${showTools?C.green:C.border}`,color:showTools?C.green:C.dim,borderRadius:4,padding:'5px 11px',fontSize:11,letterSpacing:.5}}>
              {showTools ? '✕ CLOSE' : '⚙ TOOLS'}
            </button>
          </div>
        </div>

        {/* /ES /NQ price bar */}
        <div style={{display:'flex',alignItems:'stretch',borderTop:`1px solid ${C.border}`,background:'#070c12'}}>
          {[
            {sym:esBar?.label||'SPX',data:esBar,color:esBar?.chgPct>=0?C.green:C.red},
            {sym:nqBar?.label||'NDX',data:nqBar,color:nqBar?.chgPct>=0?C.green:C.red},
          ].map(({sym,data,color},i)=>(
            <div key={sym} style={{flex:1,padding:'6px 14px',display:'flex',alignItems:'center',gap:9,borderRight:i===0?`1px solid ${C.border}`:'none'}}>
              <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:2,color:C.dim}}>{sym}</span>
              {data ? (
                <>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1,color:'#c8d8e8'}}>{data.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                  <span style={{fontSize:10,color,fontWeight:600}}>{data.chgPct>=0?'+':''}{data.chgPct.toFixed(2)}%</span>
                  <span style={{fontSize:10,color,opacity:.7}}>({data.chg>=0?'+':''}{data.chg.toFixed(2)})</span>
                </>
              ) : (
                <span style={{fontSize:12,color:C.dim,letterSpacing:1}}>{barLoading?'—':tradierToken?'—':'NO TOKEN'}</span>
              )}
            </div>
          ))}
          <button className="hv" onClick={fetchPriceBar} disabled={barLoading} style={{padding:'0 12px',background:'transparent',border:'none',borderLeft:`1px solid ${C.border}`,color:barLoading?C.dim:C.blue,fontSize:13,cursor:'pointer',minWidth:36}} title="Refresh prices">
            {barLoading?<span className="pulse">·</span>:'↺'}
          </button>
        </div>
      </div>

      {/* ═══════════════ MAIN CONTENT ════════════════════════════════════════ */}
      <div style={{padding:'14px 16px',maxWidth:920,margin:'0 auto'}}>

        {/* ── DASHBOARD TAB ──────────────────────────────────────────────── */}
        {tab==='dash' && (
          <div className="si">

            {/* ── SPX / NDX price cards ── */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              {[
                {sym:esBar?.label||'SPX',data:esBar,label:'S&P 500 Index'},
                {sym:nqBar?.label||'NDX',data:nqBar,label:'Nasdaq 100 Index'},
              ].map(({sym,data,label})=>{
                const up=data?.chgPct>=0
                const bc=data?up?C.green:C.red:C.dim
                return (
                  <div key={sym} style={{background:C.card,border:`1px solid ${data?bc+'40':C.border}`,borderRadius:6,padding:'11px 13px'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}}>
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:2,color:bc}}>{sym}</span>
                      {data && <span style={{fontSize:8,color:bc,border:`1px solid ${bc}40`,padding:'1px 5px',borderRadius:3}}>{up?'▲ BULL':'▼ BEAR'}</span>}
                    </div>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:'#c8d8e8',letterSpacing:1,lineHeight:1.1}}>
                      {data?data.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}
                    </div>
                    {data && <div style={{fontSize:10,color:bc,marginTop:2}}>{up?'+':''}{data.chgPct.toFixed(2)}% ({data.chg>=0?'+':''}{data.chg.toFixed(2)})</div>}
                    {!data && <div style={{fontSize:9,color:C.dim,marginTop:2}}>{label}</div>}
                  </div>
                )
              })}
            </div>

            {/* ── No token CTA ── */}
            {!esBar && !nqBar && (
              <div style={{background:'#04080e',border:`1px dashed ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
                <div style={{fontSize:10,color:C.blue}}>Add Tradier token in Settings to load live SPX/NDX data</div>
                <button className="hv" onClick={()=>{setToolsTab('settings');setShowTools(true)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:4,fontSize:9,cursor:'pointer',whiteSpace:'nowrap'}}>ADD TOKEN</button>
              </div>
            )}

            {/* ── Market Conviction ── */}
            <div style={{background:C.card,border:`1px solid ${marketConviction?marketConviction.color+'50':C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>MARKET CONVICTION</div>
                <button className="hv" onClick={fetchPriceBar} style={{fontSize:9,color:C.blue,background:'transparent',border:`1px solid ${C.blue}30`,padding:'2px 7px',borderRadius:3,cursor:'pointer'}}>{'↺'} REFRESH</button>
              </div>
              {marketConviction ? (
                <>
                  <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:42,color:marketConviction.color,letterSpacing:1,lineHeight:1}}>{marketConviction.score}%</div>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:marketConviction.color,letterSpacing:2}}>{marketConviction.direction}</div>
                      <div style={{fontSize:10,color:C.dim,marginTop:2}}>
                        SPX {marketConviction.spxChg>=0?'+':''}{marketConviction.spxChg?.toFixed(2)}% {'·'} NDX {marketConviction.ndxChg>=0?'+':''}{marketConviction.ndxChg?.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  <div style={{position:'relative',height:6,background:C.border,borderRadius:3,overflow:'hidden'}}>
                    <div style={{position:'absolute',left:0,top:0,height:'100%',width:marketConviction.score+'%',background:marketConviction.color,borderRadius:3,transition:'width .6s'}}/>
                    <div style={{position:'absolute',left:'50%',top:0,bottom:0,width:1,background:'#2a4a5a'}}/>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:'#2a5060',marginTop:3}}>
                    <span>BEARISH</span><span>NEUTRAL</span><span>BULLISH</span>
                  </div>
                </>
              ) : (
                <div style={{fontSize:11,color:C.dim,textAlign:'center',padding:'8px 0'}}>Fetch market data to see conviction</div>
              )}
            </div>

            {/* ── Index Setups (SPX/NDX alerts) ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>SPX / NDX INDEX SETUPS</div>
                  <div style={{fontSize:9,color:'#2a5060',marginTop:2}}>All timeframes {'·'} sorted by conviction</div>
                </div>
                <button className="hv" onClick={generateIndexAlerts} disabled={indexAlertsLoading||!tradierToken} style={{
                  background:indexAlertsLoading?'transparent':`${C.green}18`,
                  border:`1px solid ${indexAlertsLoading||!tradierToken?C.border:C.green}`,
                  color:indexAlertsLoading||!tradierToken?C.dim:C.green,
                  padding:'6px 12px',borderRadius:4,fontSize:9,letterSpacing:.8,
                  cursor:tradierToken&&!indexAlertsLoading?'pointer':'not-allowed',
                  fontFamily:"'Bebas Neue',sans-serif",
                }}>
                  {indexAlertsLoading?<span className="pulse">SCANNING</span>:'GENERATE'}
                </button>
              </div>
              {indexAlerts.length===0 && !indexAlertsLoading && (
                <div style={{fontSize:10,color:'#2a5060',textAlign:'center',padding:'10px 0'}}>
                  {tradierToken?'Hit GENERATE to scan SPX & NDX across all 4 timeframes':'Add Tradier token first'}
                </div>
              )}
              {indexAlerts.slice(0,6).map((al,i)=>{
                const high=al.score>=90; const midHit=al.score>=75
                const cardC=high?C.green:midHit?C.blue:C.dim
                return (
                  <div key={i} style={{background:'#06101a',border:`1px solid ${cardC}30`,borderRadius:4,padding:'9px 11px',marginBottom:6}}>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:4}}>
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:17,color:cardC,letterSpacing:2}}>{al.sym}</span>
                      <span style={{fontSize:10,color:'#c8d8e8'}}>{al.tradeType} {al.strikeStr}</span>
                      <span style={{fontSize:8,color:al.tfColor,border:`1px solid ${al.tfColor}40`,padding:'1px 5px',borderRadius:2}}>{al.tfBadge} {al.tfLabel}</span>
                      {high&&<span style={{fontSize:8,color:C.green,border:`1px solid ${C.green}40`,padding:'1px 5px',borderRadius:2}}>90%+ HIGH CONVICTION</span>}
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:cardC,marginLeft:'auto'}}>{al.score}%</span>
                    </div>
                    <div style={{display:'flex',gap:10,fontSize:10,color:C.dim,marginBottom:4,flexWrap:'wrap'}}>
                      <span>Entry: <span style={{color:'#8ab0c0'}}>{al.entry}</span></span>
                      <span>Tgt: <span style={{color:C.green}}>{al.target}</span></span>
                      <span>Stp: <span style={{color:C.red}}>{al.stop}</span></span>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                      <span style={{fontSize:9,color:'#3a6070'}}>Exp: {al.expiryDisplay} {'·'} IV: {al.iv} {'·'} Delta: {al.delta}</span>
                      {tgToken&&tgChatId&&(
                        <button className="hv" onClick={async()=>{await sendTelegram(buildScanAlert({...al,ticker:al.sym}),tgToken,tgChatId);setTgStatus('Sent!');setTimeout(()=>setTgStatus(''),3000)}} style={{marginLeft:'auto',background:`${C.blue}18`,border:`1px solid ${C.blue}40`,color:C.blue,padding:'3px 9px',borderRadius:3,fontSize:9,cursor:'pointer'}}>TG</button>
                      )}
                    </div>
                    {al.reasons.length>0&&<div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:5}}>{al.reasons.map((r,j)=><span key={j} style={{fontSize:8,color:cardC,background:`${cardC}10`,padding:'1px 5px',borderRadius:2}}>{r}</span>)}</div>}
                  </div>
                )
              })}
              {tgStatus&&<div style={{fontSize:10,color:C.green,marginTop:4}}>{tgStatus}</div>}
            </div>

            {/* ── Morning Readout ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:9}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>MORNING READOUT</div>
                  <div style={{fontSize:9,color:'#2a5060',marginTop:2}}>Claude AI brief {'·'} premarket news {'·'} key levels</div>
                </div>
                <button className="hv" onClick={fetchMorningBrief} disabled={briefLoading} style={{
                  background:briefLoading?'transparent':`${C.orange}18`,
                  border:`1px solid ${briefLoading?C.border:C.orange}`,
                  color:briefLoading?C.dim:C.orange,
                  padding:'6px 12px',borderRadius:4,fontSize:9,letterSpacing:.8,
                  cursor:briefLoading?'default':'pointer',fontFamily:"'Bebas Neue',sans-serif",
                }}>
                  {briefLoading?<span className="pulse">GENERATING</span>:'GENERATE'}
                </button>
              </div>
              {morningBrief ? (
                <pre style={{fontSize:10,lineHeight:1.85,color:'#8ab0c0',margin:0,whiteSpace:'pre-wrap',wordBreak:'break-word',borderTop:`1px solid ${C.border}`,paddingTop:9,fontFamily:"'IBM Plex Mono',monospace"}}>{morningBrief}</pre>
              ) : (
                <div style={{fontSize:10,color:'#2a5060',textAlign:'center',padding:'8px 0'}}>
                  Set ANTHROPIC_API_KEY in Vercel env vars to enable
                </div>
              )}
            </div>

            {/* ── Checklist ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:7}}>
                <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>PRE-TRADE CHECKLIST</div>
                <button className="hv" onClick={()=>{setToolsTab('checklist');setShowTools(true)}} style={{fontSize:9,color:C.blue,background:'transparent',border:`1px solid ${C.blue}30`,padding:'2px 7px',borderRadius:3,cursor:'pointer'}}>OPEN</button>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:32,color:clColor,letterSpacing:1,lineHeight:1}}>{clScore}%</div>
                <div>
                  <div style={{fontSize:11,color:clScore>=80?C.green:clScore>=60?C.orange:C.red}}>{clScore>=80?'STRONG SETUP':clScore>=60?'CAUTION':'SKIP THIS TRADE'}</div>
                  <div style={{fontSize:9,color:C.dim,marginTop:1}}>{Object.values(checked).filter(Boolean).length}/{CHECKLIST.length} checks</div>
                </div>
              </div>
              <div style={{width:'100%',height:4,background:C.border,borderRadius:2,overflow:'hidden'}}>
                <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s',borderRadius:2}}/>
              </div>
            </div>

            {/* ── Journal summary ── */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:12}}>
              {[
                {l:'TOTAL P&L',v:(jStats.pnl>=0?'+':'-')+'$'+Math.abs(jStats.pnl).toFixed(0),c:jStats.pnl>=0?C.green:C.red},
                {l:'WIN RATE', v:jStats.wr+'%',c:jStats.wr>=60?C.green:jStats.wr>=45?C.orange:C.red},
                {l:'OPEN',     v:String(jStats.open),c:C.blue},
              ].map((s,i)=>(
                <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'9px 11px'}}>
                  <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── SCAN TAB ────────────────────────────────────────────────────── */}
        {tab==='scan' && (
          <div className="si">
            {!tradierToken && (
              <div style={{background:'#02080e',border:`1px solid ${C.blue}30`,borderRadius:6,padding:'9px 12px',marginBottom:11,fontSize:11,color:'#5a8aaa',lineHeight:1.6}}>
                ℹ️ No token — server-side Tradier token active (Vercel env var). <button onClick={()=>{setToolsTab('settings');setShowTools(true)}} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontSize:11,padding:0,textDecoration:'underline'}}>Add token in Settings</button> to override.
              </div>
            )}

            {/* Timeframe */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:7}}>TIMEFRAME</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {Object.entries(TF_CONFIG).map(([key,cfg])=>{
                  const active=scanTF===key
                  return (
                    <button key={key} className="hv" onClick={()=>{setScanTF(key);setScanResult(null)}} style={{
                      padding:'9px 11px',borderRadius:6,cursor:'pointer',textAlign:'left',
                      background:active?`${cfg.color}18`:C.card,
                      border:`1px solid ${active?cfg.color:C.border}`,
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                        <span style={{fontSize:13}}>{cfg.badge}</span>
                        <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:12,letterSpacing:1.5,color:active?cfg.color:'#c8d8e8'}}>{cfg.label}</span>
                        {active&&<span style={{marginLeft:'auto',fontSize:8,color:cfg.color,border:`1px solid ${cfg.color}`,padding:'1px 4px',borderRadius:2}}>ACTIVE</span>}
                      </div>
                      <div style={{fontSize:10,color:active?cfg.color+'cc':C.dim}}>{cfg.desc}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Ticker + Type */}
            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:9,marginBottom:11}}>
              <div>
                <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>TICKER SYMBOL</div>
                <input value={scanTicker} onChange={e=>{setScanTicker(e.target.value.toUpperCase());setScanResult(null)}}
                  placeholder="NVDA, AAPL, SPY..." onKeyDown={e=>e.key==='Enter'&&runScan()}
                  style={{...iSt,fontSize:20,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:2}}/>
              </div>
              <Field label="Type" value={scanType} onChange={setScanType} options={['Any','Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
            </div>

            <button className="hv" onClick={runScan} disabled={scanning||!scanTicker} style={{
              width:'100%',padding:'13px',borderRadius:6,fontSize:14,letterSpacing:2,cursor:'pointer',
              fontFamily:"'Bebas Neue',sans-serif",marginBottom:12,
              background:scanning?`${C.green}10`:`${C.green}22`,
              border:`1px solid ${scanning||!scanTicker?C.border:C.green}`,
              color:scanning||!scanTicker?C.dim:C.green,
            }}>
              {scanning?<span className="pulse">🔴 FETCHING LIVE DATA — ${scanTicker}...</span>:`🔍 SCAN $${scanTicker||'TICKER'} — LIVE TRADIER DATA`}
            </button>

            {scanErr&&<div style={{background:'#1a0a10',border:`1px solid ${C.red}40`,borderRadius:6,padding:11,color:C.red,fontSize:12,marginBottom:11,lineHeight:1.6}}>{scanErr}</div>}

            {debugLog.length>0&&(
              <div style={{background:'#02080e',border:`1px solid ${C.border}`,borderRadius:6,padding:11,marginBottom:11,maxHeight:140,overflowY:'auto'}}>
                <Lbl>📡 Live Tradier Feed</Lbl>
                {debugLog.map((l,i)=>(
                  <div key={i} style={{fontSize:11,color:l.startsWith('✅')?C.green:l.includes('ERROR')||l.includes('❌')?C.red:'#4a8a9a',fontFamily:'monospace',lineHeight:1.7}}>{l}</div>
                ))}
              </div>
            )}

            {/* Scan result */}
            {scanResult&&(
              <div className="si">
                {/* Grade + ticker header */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:11,flexWrap:'wrap',gap:8}}>
                  <div style={{display:'flex',gap:11,alignItems:'center'}}>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:54,color:gradeCol(scanResult.grade),lineHeight:1,textShadow:`0 0 30px ${gradeCol(scanResult.grade)}55`}}>{scanResult.grade}</div>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:'#c8d8e8',letterSpacing:2}}>${scanResult.ticker} — {scanResult.tradeType}</div>
                      <div style={{fontSize:11,color:C.dim}}>Conviction: <span style={{color:scanResult.score>=80?C.green:C.orange}}>{scanResult.score}%</span> · {scanResult.confidence}</div>
                      <div style={{display:'inline-flex',alignItems:'center',gap:5,marginTop:4,padding:'2px 7px',borderRadius:4,background:`${scanResult.tfColor}18`,border:`1px solid ${scanResult.tfColor}40`}}>
                        <span style={{fontSize:11}}>{scanResult.tfBadge}</span>
                        <span style={{fontSize:9,color:scanResult.tfColor,letterSpacing:1}}>{scanResult.tfLabel}</span>
                      </div>
                    </div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    <button className="hv" onClick={()=>pushToAlert(scanResult)} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>→ ALERT BUILDER</button>
                    {tgToken&&tgChatId&&(
                      <button className="hv" onClick={async()=>{const r=await sendTelegram(buildScanAlert(scanResult),tgToken,tgChatId);setTgStatus(r.ok?'✅ Sent to TG!':'❌ '+r.description);setTimeout(()=>setTgStatus(''),4000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>📤 SEND TG</button>
                    )}
                    {tgStatus&&<span style={{fontSize:10,color:C.green}}>{tgStatus}</span>}
                  </div>
                </div>

                {/* Live chain stats */}
                <div style={{background:'#030d18',border:`1px solid ${C.blue}50`,borderRadius:6,padding:11,marginBottom:11}}>
                  <Lbl color={C.blue}>📡 Live Options Chain — Tradier {tradierMode}</Lbl>
                  <div className="scanrow">
                    {[
                      {l:'STOCK',v:scanResult.price,  c:'#c8d8e8'},
                      {l:'BID',  v:scanResult.bid,    c:C.red},
                      {l:'ASK',  v:scanResult.ask,    c:C.green},
                      {l:'MID',  v:scanResult.mid,    c:C.blue},
                      {l:'IV',   v:scanResult.iv,     c:C.orange},
                      {l:'DELTA',v:scanResult.delta,  c:'#c8d8e8'},
                      {l:'THETA',v:scanResult.theta,  c:C.red},
                      {l:'VOL',  v:scanResult.volume, c:C.dim},
                      {l:'O.I.', v:scanResult.oi,     c:C.dim},
                      {l:'CHG',  v:scanResult.chgPct, c:scanResult.chgPct?.startsWith('-')?C.red:C.green},
                    ].map((f,i)=>(
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
                    {l:'EXPIRY',v:scanResult.expiryDisplay,c:'#c8d8e8'},
                    {l:'STRIKE',v:scanResult.strikeStr,    c:'#c8d8e8'},
                    {l:'ENTRY', v:scanResult.entry,        c:C.blue},
                    {l:'TARGET',v:scanResult.target,       c:C.green},
                    {l:'STOP',  v:scanResult.stop,         c:C.red},
                  ].map((f,i)=>(
                    <Card key={i}>
                      <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{f.l}</div>
                      <div style={{fontSize:12,color:f.c,fontWeight:600}}>{f.v}</div>
                    </Card>
                  ))}
                </div>

                {scanResult.reasons?.length>0&&(
                  <Card style={{marginBottom:7}}>
                    <Lbl color={C.green}>✅ WHY THIS TRADE</Lbl>
                    {scanResult.reasons.map((r,i)=><div key={i} style={{fontSize:12,color:'#8ab0c0',lineHeight:1.7}}>• {r}</div>)}
                  </Card>
                )}
                {scanResult.warnings?.length>0&&(
                  <Card color={`${C.orange}40`}>
                    <Lbl color={C.orange}>⚠️ WATCH</Lbl>
                    {scanResult.warnings.map((w,i)=><div key={i} style={{fontSize:12,color:'#8a7060',lineHeight:1.7}}>• {w}</div>)}
                  </Card>
                )}
              </div>
            )}

            {/* ── Auto-scanner section ── */}
            <div style={{marginTop:18,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div>
                  <div style={{fontSize:9,color:autoOn?C.green:C.dim,letterSpacing:2,display:'flex',alignItems:'center',gap:6}}>
                    <span style={{width:6,height:6,borderRadius:'50%',background:autoOn?C.green:C.dim,display:'inline-block',boxShadow:autoOn?`0 0 8px ${C.green}`:'none'}}/>
                    AUTO-SCANNER {autoOn?'ACTIVE':'— OFF'}
                  </div>
                  <div style={{fontSize:9,color:'#2a5a6a',marginTop:2}}>
                    Every {scanFreq} min · {minScore}%+ conviction · {tgToken&&tgChatId?'✅ TG connected':'⚠️ No TG'}
                  </div>
                </div>
                <button className="hv" onClick={toggleAuto} style={{
                  background:autoOn?`${C.red}20`:`${C.green}20`,
                  border:`1px solid ${autoOn?C.red:C.green}`,
                  color:autoOn?C.red:C.green,
                  padding:'8px 18px',borderRadius:4,fontSize:12,letterSpacing:1,cursor:'pointer',
                  fontFamily:"'Bebas Neue',sans-serif",
                }}>{autoOn?'⏹ STOP':'▶ START'}</button>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:9}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>MIN CONVICTION</div>
                  <select value={minScore} onChange={e=>setMinScore(Number(e.target.value))} style={iSt}>
                    {[60,70,75,80,85,90,95].map(v=><option key={v} value={v}>{v}%+</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>FREQUENCY</div>
                  <select value={scanFreq} onChange={e=>{const f=Number(e.target.value);setScanFreq(f);if(autoOn){clearInterval(autoRef.current);autoRef.current=setInterval(runAutoScan,f*60*1000);setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ↺ Interval updated → every ${f} min · ${TF_CONFIG[scanTFRef.current]?.label||scanTFRef.current}`,...p.slice(0,99)])}}} style={iSt}>
                    {[1,2,3,5,10,15,20,30,60].map(v=><option key={v} value={v}>Every {v} {v===1?'min':'mins'}</option>)}
                  </select>
                </div>
              </div>

              <Field label="Watchlist (blank = full S&P 500)" value={watchlist} onChange={setWatchlist} placeholder="NVDA,AAPL,MSFT,SPY"/>

              {lastAlert&&(
                <div style={{background:'#020e06',border:`1px solid ${C.green}40`,borderRadius:6,padding:'10px 12px',marginTop:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <Lbl color={C.green}>🚀 LATEST ALERT</Lbl>
                    <div style={{display:'flex',gap:6}}>
                      <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildScanAlert(lastAlert));setAlertCopied(true);setTimeout(()=>setAlertCopied(false),2000)}} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'4px 10px',borderRadius:3,fontSize:9,cursor:'pointer'}}>
                        {alertCopied?'✅ COPIED':'📋 COPY'}
                      </button>
                      {tgToken&&tgChatId&&(
                        <button className="hv" onClick={async()=>{await sendTelegram(buildScanAlert(lastAlert),tgToken,tgChatId);setTgStatus('✅ Sent!');setTimeout(()=>setTgStatus(''),3000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'4px 10px',borderRadius:3,fontSize:9,cursor:'pointer'}}>📤 TG</button>
                      )}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:C.green,letterSpacing:2}}>${lastAlert.ticker}</span>
                    <span style={{fontSize:12,color:'#c8d8e8'}}>{lastAlert.tradeType} {lastAlert.strikeStr}</span>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.green}}>{lastAlert.score}%</span>
                  </div>
                  <div style={{fontSize:10,color:C.dim,marginTop:3}}>Entry: {lastAlert.entry} · Target: {lastAlert.target} · Stop: {lastAlert.stop}</div>
                  {tgStatus&&<div style={{fontSize:10,color:C.green,marginTop:4}}>{tgStatus}</div>}
                </div>
              )}

              {autoLog.length>0&&(
                <div style={{background:'#01060b',borderRadius:5,padding:9,maxHeight:160,overflowY:'auto',marginTop:9,border:`1px solid ${C.border}`}}>
                  <Lbl>Scanner Log</Lbl>
                  {autoLog.map((l,i)=>(
                    <div key={i} style={{fontSize:10,color:l.includes('🚀')?C.green:l.includes('❌')?C.red:'#2a5a6a',fontFamily:'monospace',lineHeight:1.8}}>{l}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── JOURNAL TAB ─────────────────────────────────────────────────── */}
        {tab==='journal' && (
          <div className="si">
            {/* Stats row */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:12}}>
              {[
                {l:'TOTAL P&L',v:(jStats.pnl>=0?'+':'-')+'$'+Math.abs(jStats.pnl).toFixed(0),c:jStats.pnl>=0?C.green:C.red},
                {l:'WIN RATE', v:jStats.wr+'%',c:jStats.wr>=60?C.green:jStats.wr>=45?C.orange:C.red},
                {l:'CLOSED',   v:String(jStats.total),c:C.dim},
                {l:'AVG WIN',  v:'+$'+jStats.aw.toFixed(0),c:C.green},
                {l:'AVG LOSS', v:'-$'+jStats.al.toFixed(0),c:C.red},
                {l:'OPEN',     v:String(jStats.open),c:C.blue},
              ].map((s,i)=>(
                <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'10px 12px'}}>
                  <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:s.c,letterSpacing:1}}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* P&L Chart */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:12}}>
              <Lbl>EQUITY CURVE</Lbl>
              <PnLChart trades={trades}/>
            </div>

            {/* Filter + add */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:6}}>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {['All','Open','Closed','Stopped'].map(f=><Pill key={f} label={f} active={jFilter===f} color={C.blue} onClick={()=>setJFilter(f)}/>)}
              </div>
              <button className="hv" onClick={()=>setShowAdd(p=>!p)} style={{background:showAdd?`${C.green}20`:'transparent',border:`1px solid ${showAdd?C.green:C.border}`,color:showAdd?C.green:C.dim,padding:'6px 12px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>+ LOG TRADE</button>
            </div>

            {showAdd&&(
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
                  <button className="hv" onClick={addTrade} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'7px 18px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>SAVE</button>
                  <button className="hv" onClick={()=>setShowAdd(false)} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>CANCEL</button>
                </div>
              </Card>
            )}

            {/* Trade list */}
            {(jFilter==='All'?trades:trades.filter(t=>t.status===jFilter)).length===0
              ? <div style={{color:C.dim,fontSize:12,textAlign:'center',padding:24,border:`1px dashed ${C.border}`,borderRadius:6}}>No trades yet. Hit <span style={{color:C.green}}>+ LOG TRADE</span> to start.</div>
              : (jFilter==='All'?trades:trades.filter(t=>t.status===jFilter)).map(t=>{
                  const pnl=parseFloat(t.pnl||0)
                  const stC=t.status==='Open'?C.blue:t.status==='Closed'?C.green:C.red
                  return (
                    <div key={t.id} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${stC}`,borderRadius:4,padding:'10px 13px',marginBottom:6}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:6}}>
                        <div style={{display:'flex',gap:9,alignItems:'center',flexWrap:'wrap'}}>
                          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:'#c8d8e8',letterSpacing:2}}>${t.ticker}</span>
                          <span style={{fontSize:9,color:stC,border:`1px solid ${stC}40`,padding:'2px 6px',borderRadius:3}}>{t.status.toUpperCase()}</span>
                          <span style={{fontSize:11,color:C.dim}}>{t.type}</span>
                          {t.expiry&&<span style={{fontSize:10,color:C.dim}}>{t.expiry}</span>}
                          {t.date&&<span style={{fontSize:9,color:'#2a4a5a'}}>{t.date}</span>}
                        </div>
                        <div style={{display:'flex',gap:8,alignItems:'center'}}>
                          {t.pnl&&<span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:pnl>=0?C.green:C.red}}>{pnl>=0?'+':'-'}${Math.abs(pnl)}</span>}
                          <button className="hv" onClick={()=>setTrades(p=>p.filter(x=>x.id!==t.id))} style={{background:'transparent',border:'none',color:'#2a4a5a',fontSize:12,cursor:'pointer'}}>✕</button>
                        </div>
                      </div>
                      {(t.entry||t.exitPrice)&&(
                        <div style={{display:'flex',gap:12,marginTop:5,fontSize:11,color:C.dim}}>
                          {t.entry&&<span>Entry: <span style={{color:'#8ab0c0'}}>{t.entry}</span></span>}
                          {t.exitPrice&&<span>Exit: <span style={{color:'#8ab0c0'}}>{t.exitPrice}</span></span>}
                          {t.contracts&&<span>Qty: <span style={{color:'#8ab0c0'}}>{t.contracts}</span></span>}
                        </div>
                      )}
                      {t.notes&&<div style={{marginTop:5,fontSize:11,color:'#4a6a7a',lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:5}}>{t.notes}</div>}
                    </div>
                  )
                })
            }
          </div>
        )}
      </div>

      {/* ═══════════════ BOTTOM TAB BAR ══════════════════════════════════════ */}
      <div style={{
        position:'fixed',bottom:0,left:0,right:0,zIndex:90,
        background:'#06090f',borderTop:`1px solid ${C.border}`,
        display:'grid',gridTemplateColumns:'1fr 1fr 1fr',
      }}>
        {[
          {id:'dash', icon:'◈', label:'DASHBOARD'},
          {id:'scan', icon:'⌁', label:'SCAN'},
          {id:'journal', icon:'≡', label:'JOURNAL'},
        ].map(t=>{
          const active=tab===t.id
          return (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
              padding:'11px 4px',gap:3,background:'transparent',border:'none',cursor:'pointer',
              borderTop:`2px solid ${active?C.green:'transparent'}`,
              transition:'border-color .2s',
            }}>
              <span style={{fontSize:17,lineHeight:1,color:active?C.green:C.dim}}>{t.icon}</span>
              <span style={{fontSize:9,letterSpacing:.5,fontFamily:"'IBM Plex Mono',monospace",color:active?C.green:C.dim,textTransform:'uppercase'}}>{t.label}</span>
            </button>
          )
        })}
      </div>

      {/* ═══════════════ TOOLS / SETTINGS SLIDE-IN PANEL ════════════════════ */}
      {showTools&&(
        <div style={{position:'fixed',inset:0,zIndex:200}}>
          {/* Backdrop */}
          <div onClick={()=>setShowTools(false)} style={{position:'absolute',inset:0,background:'rgba(0,0,0,.65)'}}/>
          {/* Panel */}
          <div style={{
            position:'absolute',right:0,top:0,bottom:0,
            width:'min(480px,100vw)',
            background:C.bg,borderLeft:`1px solid ${C.border}`,
            display:'flex',flexDirection:'column',
            animation:'slideIn .22s ease',
          }}>
            <style>{`@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>

            {/* Panel header */}
            <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',background:'#06090f',flexShrink:0}}>
              <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:2,color:C.green}}>TOOLS</span>
              <button className="hv" onClick={()=>setShowTools(false)} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'4px 10px',borderRadius:3,fontSize:11,cursor:'pointer'}}>✕ CLOSE</button>
            </div>

            {/* Panel sub-tabs */}
            <div style={{display:'flex',gap:4,padding:'8px 12px',borderBottom:`1px solid ${C.border}`,flexWrap:'wrap',flexShrink:0,background:'#070c12'}}>
              {[
                {id:'settings',l:'Settings'},
                {id:'alert',   l:'Alert'},
                {id:'checklist',l:'Checklist'},
                {id:'strategy',l:'Strategy'},
                {id:'exit',    l:'Exit Rules'},
                {id:'futures', l:'Futures'},
              ].map(t=>(
                <button key={t.id} onClick={()=>setToolsTab(t.id)} style={{
                  padding:'4px 10px',borderRadius:3,fontSize:10,letterSpacing:.5,cursor:'pointer',
                  border:`1px solid ${toolsTab===t.id?C.green:C.border}`,
                  color:toolsTab===t.id?C.green:C.dim,
                  background:toolsTab===t.id?`${C.green}15`:'transparent',
                }}>{t.l}</button>
              ))}
            </div>

            {/* Panel content scroll */}
            <div style={{overflowY:'auto',flex:1,padding:'14px 16px'}}>

              {/* ── SETTINGS ── */}
              {toolsTab==='settings'&&(
                <div className="si">
                  {/* Tradier */}
                  <Card style={{marginBottom:12}}>
                    <Lbl color={C.green}>📡 TRADIER DATA SOURCE</Lbl>
                    <div style={{display:'grid',gap:9,marginBottom:10}}>
                      <Field label="Bearer Token" value={tradierToken} onChange={setTradierToken} placeholder="Paste Tradier token here" type="password"/>
                      <Field label="Mode" value={tradierMode} onChange={setTradierMode} options={['production','sandbox']}/>
                    </div>
                    {tradierToken&&<div style={{fontSize:10,color:C.green}}>✓ Token set — using <strong>{tradierMode}</strong></div>}
                  </Card>

                  {/* Anthropic */}
                  <Card style={{marginBottom:12}}>
                    <Lbl color={C.orange}>🤖 CLAUDE AI — MORNING BRIEF</Lbl>
                    <div style={{background:'#0a0c06',border:`1px solid ${C.orange}30`,borderRadius:4,padding:10,marginBottom:10,fontSize:10,color:'#8a7a50',lineHeight:1.8}}>
                      <strong style={{color:C.orange}}>Option A (recommended):</strong> Set <code style={{color:C.green}}>ANTHROPIC_API_KEY</code> in Vercel → Settings → Environment Variables → redeploy.{' '}
                      <strong style={{color:C.orange}}>Option B (instant):</strong> Paste your key below — stored locally in your browser only.
                    </div>
                    <Field label="Anthropic API Key (claude.ai/settings → API Keys)" value={anthropicKey} onChange={setAnthropicKey} placeholder="sk-ant-api03-..." type="password"/>
                    {anthropicKey&&<div style={{fontSize:10,color:C.green,marginTop:6}}>✓ Key set — Morning Brief will use this key</div>}
                  </Card>

                  {/* Telegram */}
                  <Card style={{marginBottom:12}}>
                    <Lbl color={C.blue}>📱 TELEGRAM AUTO-ALERTS</Lbl>
                    <div style={{background:'#020c14',border:`1px solid ${C.blue}30`,borderRadius:4,padding:10,marginBottom:10,fontSize:10,color:'#5a8aaa',lineHeight:1.8}}>
                      <strong style={{color:C.green}}>Setup:</strong> Telegram → @BotFather → /newbot → copy token. Add bot to channel as admin.
                    </div>
                    <div style={{display:'grid',gap:8,marginBottom:10}}>
                      <Field label="Bot Token" value={tgToken} onChange={setTgToken} placeholder="7123456789:AAFxxx" type="password"/>
                      <Field label="Chat ID or @ChannelName" value={tgChatId} onChange={setTgChatId} placeholder="-1001234567890"/>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                      <button className="hv" onClick={async()=>{
                        setTgStatus('sending...')
                        const r=await sendTelegram(`🤖 *OPTIONS EDGE Connected!*\n\nAlerts active at ${minScore}%+ conviction.\n\n_${new Date().toLocaleString()}_`,tgToken,tgChatId)
                        setTgStatus(r.ok?'✅ Message sent!':'❌ Failed: '+(r.description||r.error||'check token'))
                        setTimeout(()=>setTgStatus(''),5000)
                      }} disabled={!tgToken||!tgChatId} style={{background:tgToken&&tgChatId?`${C.blue}20`:'transparent',border:`1px solid ${tgToken&&tgChatId?C.blue:C.border}`,color:tgToken&&tgChatId?C.blue:C.dim,padding:'7px 16px',borderRadius:4,fontSize:10,letterSpacing:.8,cursor:tgToken&&tgChatId?'pointer':'not-allowed'}}>
                        📤 SEND TEST
                      </button>
                      {tgStatus&&<span style={{fontSize:11,color:tgStatus.startsWith('✅')?C.green:C.red}}>{tgStatus}</span>}
                    </div>
                  </Card>
                </div>
              )}

              {/* ── ALERT BUILDER ── */}
              {toolsTab==='alert'&&(
                <div className="si">
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                    <Field label="Trade Type" value={alert.type} onChange={v=>setAlert(p=>({...p,type:v}))} options={['Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
                    <Field label="Ticker" value={alert.ticker} onChange={v=>setAlert(p=>({...p,ticker:v.toUpperCase()}))} placeholder="NVDA"/>
                    <Field label="Expiry" value={alert.expiry} onChange={v=>setAlert(p=>({...p,expiry:v}))} placeholder="May 16 2026"/>
                    <Field label="Strike" value={alert.strike} onChange={v=>setAlert(p=>({...p,strike:v}))} placeholder="210C"/>
                    <Field label="Entry" value={alert.entry} onChange={v=>setAlert(p=>({...p,entry:v}))} placeholder="$3.50 – $3.80"/>
                    <Field label="Target" value={alert.target} onChange={v=>setAlert(p=>({...p,target:v}))} placeholder="$6.50 (+85%)"/>
                    <Field label="Stop Loss" value={alert.stop} onChange={v=>setAlert(p=>({...p,stop:v}))} placeholder="$1.75 (-50%)"/>
                    <Field label="Size" value={alert.size} onChange={v=>setAlert(p=>({...p,size:v}))} placeholder="1–3 contracts"/>
                  </div>
                  <div style={{display:'grid',gap:8,marginBottom:12}}>
                    <Field label="Trade Thesis" value={alert.thesis} onChange={v=>setAlert(p=>({...p,thesis:v}))} placeholder="Why you're entering..." rows={2}/>
                    <Field label="Catalyst" value={alert.catalyst} onChange={v=>setAlert(p=>({...p,catalyst:v}))} placeholder="Earnings, breakout..." rows={1}/>
                    <Field label="Options Flow" value={alert.flow} onChange={v=>setAlert(p=>({...p,flow:v}))} placeholder="Unusual sweeps..." rows={1}/>
                  </div>
                  <Card color={C.border} style={{background:'#050c14'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:9}}>
                      <Lbl>📱 Preview</Lbl>
                      <div style={{display:'flex',gap:6}}>
                        <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildTgAlert(alert));setCopied(true);setTimeout(()=>setCopied(false),2000)}} style={{background:copied?`${C.green}20`:'transparent',border:`1px solid ${copied?C.green:C.border}`,color:copied?C.green:C.dim,padding:'5px 11px',borderRadius:3,fontSize:9,cursor:'pointer'}}>
                          {copied?'✅ COPIED':'📋 COPY'}
                        </button>
                        {tgToken&&tgChatId&&(
                          <button className="hv" onClick={async()=>{const r=await sendTelegram(buildTgAlert(alert),tgToken,tgChatId);setTgStatus(r.ok?'✅ Sent!':'❌ '+r.description);setTimeout(()=>setTgStatus(''),4000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'5px 11px',borderRadius:3,fontSize:9,cursor:'pointer'}}>📤 SEND</button>
                        )}
                      </div>
                    </div>
                    {tgStatus&&<div style={{fontSize:10,color:C.green,marginBottom:7}}>{tgStatus}</div>}
                    <pre style={{fontSize:10,lineHeight:1.8,color:'#8ab0c0',margin:0,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{buildTgAlert(alert)}</pre>
                  </Card>
                </div>
              )}

              {/* ── CHECKLIST ── */}
              {toolsTab==='checklist'&&(
                <div className="si">
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:clColor,letterSpacing:2}}>
                        {clScore}% — {clScore>=80?'STRONG SETUP 🔥':clScore>=60?'CAUTION ⚠️':'SKIP ❌'}
                      </div>
                      <div style={{fontSize:10,color:C.dim}}>{Object.values(checked).filter(Boolean).length} of {CHECKLIST.length} met</div>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <div style={{width:70,height:5,background:C.border,borderRadius:3,overflow:'hidden'}}>
                        <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s'}}/>
                      </div>
                      <button className="hv" onClick={()=>setChecked({})} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'4px 9px',borderRadius:3,fontSize:9,cursor:'pointer'}}>RESET</button>
                    </div>
                  </div>
                  {['TA','Flow','News','Risk'].map(cat=>(
                    <div key={cat} style={{marginBottom:13}}>
                      <div style={{fontSize:9,letterSpacing:2,color:CAT_COLOR[cat],marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
                        <span style={{display:'inline-block',width:12,height:1.5,background:CAT_COLOR[cat]}}/>
                        {cat==='TA'?'TECHNICAL':cat==='Flow'?'OPTIONS FLOW':cat==='News'?'NEWS / CATALYST':'RISK MGMT'}
                      </div>
                      {CHECKLIST.filter(i=>i.cat===cat).map(item=>(
                        <div key={item.id} className="hv" onClick={()=>setChecked(p=>({...p,[item.id]:!p[item.id]}))}
                          style={{display:'flex',gap:9,padding:'7px 10px',borderRadius:4,marginBottom:4,
                            background:checked[item.id]?`${CAT_COLOR[cat]}0a`:C.card,
                            border:`1px solid ${checked[item.id]?CAT_COLOR[cat]+'40':C.border}`}}>
                          <div style={{width:14,height:14,borderRadius:2,border:`2px solid ${checked[item.id]?CAT_COLOR[cat]:'#2a4a5a'}`,background:checked[item.id]?CAT_COLOR[cat]:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1}}>
                            {checked[item.id]&&<span style={{color:'#000',fontSize:8,fontWeight:700}}>✓</span>}
                          </div>
                          <div>
                            <div style={{fontSize:11,color:checked[item.id]?'#c8d8e8':'#8ab0c0'}}>{item.l}</div>
                            <div style={{fontSize:10,color:'#3a5a6a',marginTop:1}}>{item.d}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* ── STRATEGY ── */}
              {toolsTab==='strategy'&&(
                <div className="si">
                  {[
                    {t:'CALLS & PUTS',c:C.green,rules:['2+ TA signals required before entry','Avoid RSI > 75 (calls) or < 25 (puts)','Volume 1.5x+ above 20-day average','MACD crossover confirms direction','Options flow sweep = green light','21–45 DTE swings, 5–14 DTE quick plays']},
                    {t:'SPREADS',c:C.blue,rules:['Debit spreads when IVR < 30','Credit spreads when IVR > 50','Short strike at key S/R level','Min 1:1 risk/reward, target 1:2','Width: 5–10pts SPX, 2.5–5 stocks','Target 50–65% of max profit on credit']},
                    {t:'CONDORS & STRANGLES',c:C.orange,rules:['IVR > 50 ideally > 70','No earnings/events within expiry','ATR contracting 5+ sessions','Sell 1–2 SD OTM strikes','Collect 25–33% of width as credit','Close at 50% profit or 21 DTE']},
                  ].map((s,i)=>(
                    <div key={i} style={{marginBottom:14}}>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:s.c,letterSpacing:2,marginBottom:6}}>{s.t}</div>
                      {s.rules.map((r,j)=>(
                        <div key={j} style={{display:'flex',gap:8,marginBottom:4,fontSize:11,color:'#8ab0c0'}}>
                          <span style={{color:s.c,flexShrink:0}}>→</span>{r}
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{background:'#050c14',border:`1px dashed ${C.border}`,borderRadius:4,padding:11,fontSize:11,color:'#6a9aaa',lineHeight:1.7}}>
                    <span style={{fontSize:9,color:C.dim,letterSpacing:2}}>GOLDEN RULE — </span>
                    Require <span style={{color:C.green}}>2+ TA</span> + <span style={{color:C.blue}}>1 flow</span> or <span style={{color:C.orange}}>1 catalyst</span> before entry.
                  </div>
                </div>
              )}

              {/* ── EXIT RULES ── */}
              {toolsTab==='exit'&&(
                <div className="si">
                  {EXIT_RULES.map((sec,i)=>(
                    <div key={i} style={{marginBottom:16}}>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:sec.color,letterSpacing:2,marginBottom:7}}>{sec.type}</div>
                      {sec.rules.map((r,j)=>(
                        <div key={j} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${sec.color}`,borderRadius:4,padding:'8px 12px',display:'grid',gridTemplateColumns:'100px 1fr',gap:8,alignItems:'center',marginBottom:4}}>
                          <span style={{fontSize:9,color:sec.color,letterSpacing:.8,fontWeight:600}}>{r.tr.toUpperCase()}</span>
                          <span style={{fontSize:11,color:'#8ab0c0',lineHeight:1.5}}>{r.a}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <Card color={`${C.red}50`}>
                    <Lbl color={C.red}>⚠️ CARDINAL RULES</Lbl>
                    {['Never widen your stop to give it more room','If unsure whether to exit — exit. Re-enter later','Always post exits to your Telegram channel','Partial exits: book 50% at target, trail the rest'].map((r,i)=>(
                      <div key={i} style={{display:'flex',gap:7,marginBottom:4,fontSize:11,color:'#8ab0c0'}}>
                        <span style={{color:C.red,flexShrink:0}}>→</span>{r}
                      </div>
                    ))}
                  </Card>
                </div>
              )}

              {/* ── FUTURES ── */}
              {toolsTab==='futures'&&(
                <div className="si">
                  <div style={{display:'flex',gap:6,marginBottom:11,flexWrap:'wrap'}}>
                    {Object.entries(FUT_SYMBOLS).map(([sym,cfg])=>(
                      <button key={sym} className="hv" onClick={()=>{setFutSym(sym);setFutData(null);setFutErr('')}} style={{
                        padding:'7px 12px',borderRadius:4,cursor:'pointer',
                        fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:1.5,
                        border:`1px solid ${futSym===sym?C.green:C.border}`,
                        color:futSym===sym?C.green:C.dim,
                        background:futSym===sym?`${C.green}18`:C.card,
                      }}>
                        <div>{cfg.display}</div>
                        <div style={{fontSize:8,fontFamily:"'IBM Plex Mono',monospace",opacity:.6,marginTop:1}}>{cfg.name.split('—')[1]?.trim()||''}</div>
                      </button>
                    ))}
                  </div>

                  <button className="hv" onClick={()=>fetchFutures(futSym)} disabled={futLoading} style={{
                    width:'100%',padding:'11px',borderRadius:5,fontSize:12,letterSpacing:2,
                    fontFamily:"'Bebas Neue',sans-serif",marginBottom:10,cursor:'pointer',
                    background:futLoading?`${C.blue}10`:`${C.blue}22`,
                    border:`1px solid ${futLoading?C.border:C.blue}`,
                    color:futLoading?C.dim:C.blue,
                  }}>
                    {futLoading?<span className="pulse">🔴 FETCHING {FUT_SYMBOLS[futSym]?.display}...</span>:`📡 FETCH ${futSym} — ${FUT_SYMBOLS[futSym]?.name}`}
                  </button>

                  {futErr&&(
                    <div style={{background:'#1a0a10',border:`1px solid ${C.red}40`,borderRadius:5,padding:10,marginBottom:10,lineHeight:1.6}}>
                      <div style={{color:C.red,fontSize:11,marginBottom:5}}>{futErr}</div>
                      <div style={{fontSize:10,color:'#6a3040'}}>
                        <strong style={{color:C.orange}}>Tip:</strong> Futures + index symbols need Tradier production tier.
                        The ETF proxy (SPY/QQQ etc.) always works — it's loaded as final fallback automatically.
                        If all 3 fail, your token is missing or invalid — add it in Settings.
                      </div>
                    </div>
                  )}

                  {futData&&(
                    <div>
                      <div style={{marginBottom:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                          <div>
                            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:'#c8d8e8',letterSpacing:2}}>
                              {futData.cfg.display} <span style={{fontSize:11,color:futData.usingFutures?C.green:C.orange}}>{futData.usingFutures?'● LIVE':'● INDEX'}</span>
                            </div>
                            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:34,color:futData.biasColor,letterSpacing:1}}>${futData.price.toFixed(2)}</div>
                            <div style={{display:'flex',gap:8,alignItems:'center',marginTop:3}}>
                              <span style={{fontSize:12,color:futData.chgPct>=0?C.green:C.red}}>{futData.chgPct>=0?'+':''}{futData.chgPct.toFixed(2)}%</span>
                              <span style={{fontSize:10,color:futData.biasColor,padding:'1px 7px',borderRadius:3,border:`1px solid ${futData.biasColor}40`,background:`${futData.biasColor}15`}}>{futData.bias}</span>
                              <span style={{fontSize:9,color:C.dim}}>{futData.fetchedAt}</span>
                            </div>
                          </div>
                          <button className="hv" onClick={()=>fetchFutures(futData.sym)} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:3,fontSize:9,cursor:'pointer'}}>↺ REFRESH</button>
                        </div>

                        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:10}}>
                          {[
                            {l:'OPEN',  v:'$'+futData.open.toFixed(2),  c:'#c8d8e8'},
                            {l:'HIGH',  v:'$'+futData.hi.toFixed(2),    c:C.green},
                            {l:'LOW',   v:'$'+futData.lo.toFixed(2),    c:C.red},
                            {l:'52W HI',v:'$'+futData.hi52.toFixed(2),  c:C.green},
                            {l:'52W LO',v:'$'+futData.lo52.toFixed(2),  c:C.red},
                            {l:'CHAIN', v:futData.chainLen+' opts',      c:C.dim},
                          ].map((f,i)=>(
                            <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:'6px 8px'}}>
                              <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>{f.l}</div>
                              <div style={{fontSize:11,color:f.c,fontWeight:600}}>{f.v}</div>
                            </div>
                          ))}
                        </div>

                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                          <div style={{background:'#04080d',border:`1px solid ${C.red}40`,borderRadius:5,padding:11}}>
                            <Lbl color={C.red}>🔴 RESISTANCE</Lbl>
                            {futData.resistance.length===0
                              ?<div style={{fontSize:11,color:C.dim}}>None found</div>
                              :futData.resistance.map((lvl,i)=>(
                                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<futData.resistance.length-1?`1px solid ${C.border}`:'none'}}>
                                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:C.red}}>${lvl.toFixed(2)}</span>
                                  <span style={{fontSize:9,color:C.dim}}>{((lvl/futData.price-1)*100).toFixed(1)}%</span>
                                </div>
                              ))
                            }
                          </div>
                          <div style={{background:'#020d06',border:`1px solid ${C.green}40`,borderRadius:5,padding:11}}>
                            <Lbl color={C.green}>🟢 SUPPORT</Lbl>
                            {futData.support.length===0
                              ?<div style={{fontSize:11,color:C.dim}}>None found</div>
                              :futData.support.map((lvl,i)=>(
                                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<futData.support.length-1?`1px solid ${C.border}`:'none'}}>
                                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:C.green}}>${lvl.toFixed(2)}</span>
                                  <span style={{fontSize:9,color:C.dim}}>{(((lvl/futData.price)-1)*100).toFixed(1)}%</span>
                                </div>
                              ))
                            }
                          </div>
                        </div>

                        {futData.tradeSetups.length>0&&(
                          <div>
                            <Lbl>TRADE SETUPS</Lbl>
                            {futData.tradeSetups.map((s,i)=>(
                              <div key={i} style={{background:C.card,border:`1px solid ${s.color}40`,borderRadius:5,padding:10,marginBottom:7}}>
                                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                                  <div style={{display:'flex',gap:7,alignItems:'center'}}>
                                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:s.color,letterSpacing:1}}>{s.type}</span>
                                    <span style={{fontSize:11,color:'#c8d8e8'}}>{s.strike}</span>
                                    <span style={{fontSize:9,color:s.color,border:`1px solid ${s.color}40`,padding:'1px 5px',borderRadius:2}}>{s.conviction}</span>
                                  </div>
                                </div>
                                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4}}>
                                  {[
                                    {l:'ENTRY',v:s.entry,c:C.blue},
                                    {l:'TARGET',v:s.target,c:C.green},
                                    {l:'STOP',v:s.stop,c:C.red},
                                  ].map((f,j)=>(
                                    <div key={j} style={{background:'#06101a',borderRadius:3,padding:'5px 7px'}}>
                                      <div style={{fontSize:7,color:C.dim,letterSpacing:1.5,marginBottom:1}}>{f.l}</div>
                                      <div style={{fontSize:10,color:f.c,fontWeight:600}}>{f.v}</div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{display:'flex',gap:12,marginTop:6,fontSize:10,color:C.dim}}>
                                  <span>IV: <span style={{color:'#8ab0c0'}}>{s.iv}</span></span>
                                  <span>Δ: <span style={{color:'#8ab0c0'}}>{s.delta}</span></span>
                                  <span>OI: <span style={{color:'#8ab0c0'}}>{s.oi.toLocaleString()}</span></span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </div>
  )
}
