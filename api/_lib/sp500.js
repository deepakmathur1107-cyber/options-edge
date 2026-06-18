// api/_lib/sp500.js
// Ported from src/App.jsx's SP500 constant — used by the cron scanner.
// Keep these in sync if the frontend list changes.

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
  {id:'vol',  cat:'TA',   l:'Volume Above Average',      d:'At least 1.2x the 20-day avg — NOT first 30 min'},
  {id:'macd', cat:'TA',   l:'MACD Confirmation',         d:'Crossover in trade direction'},
  {id:'lvl',  cat:'TA',   l:'Key Level Identified',      d:'Clear S/R, trendline, or breakout'},
  {id:'notch',cat:'TA',   l:'Stock NOT already moved >2% today', d:'Chasing a gap = paying inflated premium. Wait for a pullback or skip.'},
  {id:'flow', cat:'Flow', l:'Options Flow Checked',      d:'Unusual sweeps align with thesis'},
  {id:'oi',   cat:'Flow', l:'Open Interest at Strikes',  d:'High OI at your strikes = magnet zones'},
  {id:'iv',   cat:'Flow', l:'IV Rank Assessed',          d:'Buy low IV (<40%), sell high IV (>55%). MSTR at 66% = sell, not buy.'},
  {id:'voloc',cat:'Flow', l:'Volume has directional context', d:'High vol alone means nothing — sweeps on ASK = buying, BID = selling. Confirm directionality.'},
  {id:'cat',  cat:'News', l:'Catalyst Identified',       d:'Know the SPECIFIC WHY — earnings date, product launch, macro event, technical breakout'},
  {id:'time', cat:'News', l:'Catalyst Timing Clear',     d:'Event date vs expiry date checked. No catalyst = no long option.'},
  {id:'beven',cat:'News', l:'Break-even is realistic',   d:'Stock must reach strike + premium by expiry. Is that move historically probable?'},
  {id:'size', cat:'Risk', l:'Position Sized Correctly',  d:'Max 2–5% of account per trade'},
  {id:'stop', cat:'Risk', l:'Stop Loss Defined',         d:'50% loss on debit, 2x on credit'},
  {id:'tgt',  cat:'Risk', l:'Profit Target Set',         d:'25–50% quick, 50–100% swings'},
  {id:'plan', cat:'Risk', l:'Exit Scenario Planned',     d:'What if it goes against you?'},
  {id:'time2',cat:'Risk', l:'If entering at open: size is reduced', d:'First 30 min is volatile — spreads are wider and volume signals are unreliable. Still tradeable if conviction is high, but use a limit at mid and size 50% of normal.'},
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

function Field({ label, value, onChange, placeholder, options, rows, type='text', C: lC }) {
  const themeC = lC || C
  const fSt = {
    width:'100%', background:themeC.inputBg, border:`1px solid ${themeC.border}`,
    borderRadius:4, color:themeC.text, padding:'9px 12px',
    fontSize:12, fontFamily:'inherit', transition:'border-color .15s',
  }
  return (
    <div>
      <div style={{fontSize:11,fontWeight:600,color:themeC.dim,letterSpacing:0.5,marginBottom:4,textTransform:'uppercase',fontFamily:"'Inter',sans-serif"}}>{label}</div>
      {options
        ? <select value={value} onChange={e=>onChange(e.target.value)} style={fSt}>
            {options.map(o=><option key={o.v||o} value={o.v||o}>{o.l||o}</option>)}
          </select>
        : rows
          ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{...fSt,resize:'vertical'}}/>
          : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={fSt}/>
      }
    </div>
  )
}

function Card({ color, children, style={}, C: lC }) {
  const themeC = lC || C
  return (
    <div style={{background:themeC.card,border:`1px solid ${color||themeC.border}`,borderRadius:6,padding:14,...style}}>
      {children}
    </div>
  )
}

function Lbl({ children, color, C: lC }) {
  const themeC = lC || C
  return <div style={{fontSize:11,fontWeight:600,color:color??themeC.dim,letterSpacing:0.5,marginBottom:6,textTransform:'uppercase',fontFamily:"'Inter',sans-serif"}}>{children}</div>
}

function Pill({ label, active, color, onClick, C: lC }) {
  const themeC = lC || C
  const pillColor = color ?? themeC.green
  return (
    <button onClick={onClick} style={{
      padding:'7px 14px',borderRadius:4,fontSize:11,letterSpacing:.8,cursor:'pointer',
      border:`1px solid ${active?pillColor:themeC.border}`,color:active?pillColor:themeC.dim,
      background:active?`${pillColor}18`:'transparent',
    }}>{label}</button>
  )
}

// ─── P&L Sparkline ────────────────────────────────────────────────────────────
function PnLChart({ trades, C: lC }) {
  const themeC = lC || C
  const closed = [...trades].filter(t=>t.status!=='Open').reverse()
  if (closed.length < 2) return (
    <div style={{textAlign:'center',padding:'20px 0',fontSize:11,color:themeC.dim,border:`1px dashed ${themeC.border}`,borderRadius:6}}>
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
  const lineColor = lastY>=0?themeC.green:themeC.red
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
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={themeC.border} strokeWidth={1} strokeDasharray="4,4"/>
        <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#pgrd)"/>
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.8}/>
        <circle cx={(cumPnL.length-1)/(cumPnL.length-1)*W} cy={toY(lastY)} r={3} fill={lineColor}/>
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:themeC.dim,marginTop:3,letterSpacing:.5}}>
        <span>{closed[0]?.date||closed[0]?.ticker||''}</span>
        <span>{closed[closed.length-1]?.date||closed[closed.length-1]?.ticker||''}</span>
      </div>
    </div>
  )
}

// ─── Tradier API proxy ────────────────────────────────────────────────────────
async function tradierGet(path, token, mode, authToken) {
  const headers = {}
  if (authToken) {
    // Phase 2: Clerk JWT → server uses admin TRADIER_TOKEN
    headers['Authorization'] = `Bearer ${authToken}`
  } else if (token) {
    // Phase 1 legacy / sandbox override: user-provided token
    headers['x-tradier-token'] = token
    headers['x-tradier-mode']  = mode || 'sandbox'
  } else {
    // No auth at all — still try, server may have admin token configured
    // (works when TRADIER_TOKEN is set in Vercel env vars)
  }
  const res = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, { headers })
  if (!res.ok) {
    const raw = await res.text().catch(()=>'')
    let err = {}
    try { err = JSON.parse(raw) } catch {}
    if (res.status === 429 && err.upgrade) throw new Error('USAGE_LIMIT:' + err.error)
    throw new Error(`Tradier ${res.status}: ${err.error || raw.slice(0,80)}`)
  }
  return res.json()
}

async function sendTelegram(message, token, chatId, authToken) {
  const headers = {'Content-Type':'application/json'}
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`
  const res = await fetch('/api/telegram', {
    method:'POST',
    headers,
    body:JSON.stringify({message,token,chat_id:chatId}),
  })
  return res.json()
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App(props={}) {
  // props.getToken — async function from Router that returns Clerk JWT

  // ── auth token from Router (Phase 2) ──
  const getAuthToken = props.getToken || (async () => null)
  // Phase 2: admin key is always active — no per-user token required.
  // hasDataAccess = true when admin key is set OR user has a personal token (legacy).
  // Used to gate UI elements that need market data.
  const hasDataAccess = true   // admin TRADIER_TOKEN always present on server

  // ── Cloud API helpers ──────────────────────────────────────────────────────
  const cloudGet = async (path) => {
    const token = await getAuthToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await fetch(path, { headers })
    if (!res.ok) throw new Error(`${path} ${res.status}`)
    return res.json()
  }
  const cloudPost = async (path, body, method='POST') => {
    const token = await getAuthToken()
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(path, { method, headers, body: JSON.stringify(body) })
    if (!res.ok) {
      const err = await res.json().catch(()=>({error:res.statusText}))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  }

  // ── theme ──
  const isDark    = props.isDark    ?? true
  const setIsDark = props.setIsDark ?? (() => {})
  const C         = isDark ? DARK_THEME : LIGHT_THEME
  const iSt = {
    width:'100%', background:C.inputBg, border:`1px solid ${C.border}`,
    borderRadius:4, color:C.text, padding:'9px 12px',
    fontSize:12, fontFamily:'inherit', transition:'border-color .15s',
  }

  // ── main tab & tools panel ──
  const [tab,        setTab]        = useState('dash')
  const [paperToast, setPaperToast] = useState('')        // confirmation toast
  const [showTools,  setShowTools]  = useState(false)
  const [toolsTab,   setToolsTab]   = useState('settings')
  const [feedbackText,    setFeedbackText]    = useState('')
  const [feedbackType,    setFeedbackType]    = useState('suggestion')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackSent,    setFeedbackSent]    = useState(false)
  const [feedbackErr,     setFeedbackErr]     = useState('')
  const [adminFeedback,   setAdminFeedback]   = useState([])
  const [adminFbLoading,  setAdminFbLoading]  = useState(false)
  const [adminFbErr,      setAdminFbErr]      = useState('')

  // ── settings ──
  const [tradierToken, setTradierToken] = useState(()=>ls('tradierToken'))
  const [tradierMode,  setTradierMode]  = useState(()=>ls('tradierMode','production'))
  const [tgToken,      setTgToken]      = useState(()=>ls('tgToken'))
  const [tgChatId,     setTgChatId]     = useState(()=>ls('tgChatId'))
  const [tgSaving,     setTgSaving]     = useState(false)
  const [tgSaveStatus, setTgSaveStatus] = useState('')
  const [watchlist,    setWatchlist]    = useState(()=>ls('watchlist','NVDA,AAPL,MSFT,SPY,TSLA'))
  const [minScore,     setMinScore]     = useState(()=>Number(ls('minScore','80')))
  const [scanFreq,     setScanFreq]     = useState(()=>Number(ls('scanFreq','5')))
  const [tgStatus,     setTgStatus]     = useState('')

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
  const [lastRefreshed, setLastRefreshed] = useState(null)
  const [nextRefresh,   setNextRefresh]   = useState(30)

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

  // ── alert preferences (Settings tab — source of truth) ──
  const [alertPrefs,       setAlertPrefs]       = useState({ email_alerts:false, alert_email:'', min_edge_score:50, symbols:['SPY','QQQ'] })
  const [alertPrefsLoaded, setAlertPrefsLoaded] = useState(false)
  const [alertPrefsSaving, setAlertPrefsSaving] = useState(false)
  const [alertPrefsSaved,  setAlertPrefsSaved]  = useState(false)
  const [alertPrefsErr,    setAlertPrefsErr]    = useState('')
  const [customSymInput,   setCustomSymInput]   = useState('')
  useEffect(()=>{
    if (alertPrefsLoaded) return
    getAuthToken().then(token=>{
      if (!token) { setAlertPrefsLoaded(true); return }
      fetch('/api/user/prefs',{headers:{Authorization:`Bearer ${token}`}})
        .then(r=>r.json())
        .then(d=>{
          if (d.prefs) {
            setAlertPrefs(p=>({...p,...d.prefs}))
            // Sync min_edge_score → auto-scanner minScore
            if (d.prefs.min_edge_score) setMinScore(d.prefs.min_edge_score)
          }
          setAlertPrefsLoaded(true)
        })
        .catch(()=>setAlertPrefsLoaded(true))
    }).catch(()=>setAlertPrefsLoaded(true))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  const submitFeedback = async()=>{
    if(!feedbackText.trim()) return
    setFeedbackSending(true); setFeedbackErr('')
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/user/prefs?action=feedback',{
        method:'POST',
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({type:feedbackType,message:feedbackText.trim(),email:userEmail})
      })
      if(!res.ok) throw new Error(`HTTP ${res.status}`)
      setFeedbackSent(true); setFeedbackText(''); setTimeout(()=>setFeedbackSent(false),4000)
    } catch(e){ setFeedbackErr(e.message) }
    finally { setFeedbackSending(false) }
  }

  const loadAdminFeedback = async()=>{
    setAdminFbLoading(true); setAdminFbErr('')
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/user/prefs?action=feedback',{headers:token?{Authorization:`Bearer ${token}`}:{}})
      const d = await res.json()
      if(!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setAdminFeedback(d.feedback||[])
    } catch(e){ setAdminFbErr(e.message); console.error('Admin feedback load:',e.message) }
    finally { setAdminFbLoading(false) }
  }

  const saveTgPrefs = async()=>{
    if (!isAdmin) return
    setTgSaving(true); setTgSaveStatus('')
    try {
      const token = await getAuthToken()
      const r = await fetch('/api/user/prefs',{method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({...alertPrefs, tg_token:tgToken, tg_chat_id:tgChatId})})
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setTgSaveStatus('saved'); setTimeout(()=>setTgSaveStatus(''),3000)
    } catch(e){ setTgSaveStatus('error:'+e.message) }
    finally { setTgSaving(false) }
  }

  const saveAlertPrefs = async()=>{
    setAlertPrefsSaving(true); setAlertPrefsErr('')
    // Keep minScore in sync when saving
    setMinScore(alertPrefs.min_edge_score)
    try {
      const token = await getAuthToken()
      const r = await fetch('/api/user/prefs',{method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify(alertPrefs)})
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setAlertPrefsSaved(true); setTimeout(()=>setAlertPrefsSaved(false),3000)
    } catch(e){ setAlertPrefsErr('Save failed — '+e.message) }
    finally { setAlertPrefsSaving(false) }
  }
  const toggleAlertSym = sym=>{
    setAlertPrefs(p=>{
      const has=p.symbols.includes(sym)
      if (!has && p.symbols.length>=10) return p
      return {...p, symbols: has ? p.symbols.filter(s=>s!==sym) : [...p.symbols,sym]}
    })
  }
  const addCustomSym = ()=>{
    const s=customSymInput.trim().toUpperCase()
    if (!s || alertPrefs.symbols.includes(s) || alertPrefs.symbols.length>=10) return
    setAlertPrefs(p=>({...p,symbols:[...p.symbols,s]}))
    setCustomSymInput('')
  }

  // ── journal ──
  const [trades,          setTrades]        = useState(()=>{try{return JSON.parse(ls('trades','[]'))}catch{return[]}})
  const [tradesLoaded,    setTradesLoaded]   = useState(false)
  const [tradesSyncing,   setTradesSyncing]  = useState(false)
  const [usageLimitHit,   setUsageLimitHit]  = useState(false)
  const [usageCount,      setUsageCount]     = useState(0)
  const [scanLimit]       = useState(4)  // free tier limit
  const [showAdd,  setShowAdd]  = useState(false)
  const [jFilter,  setJFilter]  = useState('All')
  const [newTrade, setNewTrade] = useState({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:'',conviction:'',iv:'',chgPctAtEntry:'',strike:'',breakevenReqPct:''})
  useEffect(()=>{try{localStorage.setItem('trades',JSON.stringify(trades))}catch{}},[trades])

  // Load trades from cloud on mount (merges with localStorage)
  useEffect(()=>{
    if (tradesLoaded) return
    getAuthToken().then(token => {
      if (!token) { setTradesLoaded(true); return }
      fetch('/api/user/trades', { headers:{ Authorization:`Bearer ${token}` } })
        .then(r=>r.json())
        .then(d=>{
          if (d.trades?.length > 0) {
            // Cloud is source of truth — replace localStorage
            setTrades(d.trades.map(t=>({
              id: t.id, ticker:t.ticker, type:t.type, status:t.status,
              entry:t.entry, exitPrice:t.exit_price, pnl:String(t.pnl||''),
              contracts:t.contracts, strike:t.strike, expiry:t.expiry,
              date:t.logged_at?.split('T')[0]||'', notes:t.notes||'',
              conviction:String(t.conviction||''), iv:String(t.iv_at_entry||''),
              chgPctAtEntry:String(t.chg_pct_at_entry||''),
              breakevenReqPct:String(t.be_req_pct||''),
              hardBlockCount:String(t.hard_block_count||0), grade:t.grade||'',
            })))
            try { localStorage.setItem('trades', JSON.stringify(d.trades)) } catch {}
          }
          setTradesLoaded(true)
        })
        .catch(()=>setTradesLoaded(true))
    }).catch(()=>setTradesLoaded(true))
  }, [])

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
  const [scanType,   setScanType]   = useState(()=>ls('scanType','Any'))
  const [scanTF,     setScanTF]     = useState(()=>ls('scanTF','Swing (21–45 DTE)'))
  useEffect(()=>{try{localStorage.setItem('scanTF',   scanTF)}   catch{}},[scanTF])
  useEffect(()=>{try{localStorage.setItem('scanType', scanType)} catch{}},[scanType])
  const [scanning,   setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanErr,    setScanErr]    = useState('')
  const [srData,      setSrData]      = useState(null)
  const [tickerBrief, setTickerBrief] = useState(null)
  const [srLoading,   setSrLoading]   = useState(false)
  const [debugLog,   setDebugLog]   = useState([])

  // ── auto-scanner ──
  const [autoOn,      setAutoOn]      = useState(false)
  const [autoLog,     setAutoLog]     = useState([])
  const [lastAlert,   setLastAlert]   = useState(null)
  const [alertHistory, setAlertHistory] = useState([])   // last 10 full alert objects
  const [selectedAlert, setSelectedAlert] = useState(null) // expanded detail
  const [alertCopied, setAlertCopied] = useState(false)
  const autoRef    = useRef(null)
  const stopRef    = useRef(false)     // set true → running scan loop exits immediately
  const scanTFRef  = useRef(scanTF)   // always holds live scanTF — avoids stale closure in interval
  useEffect(()=>{ scanTFRef.current = scanTF },[scanTF])

  // ── futures (tools panel) ──
  const [futSym,     setFutSym]     = useState('ES')
  const [futData,    setFutData]    = useState(null)
  const [futLoading, setFutLoading] = useState(false)
  const [futErr,     setFutErr]     = useState('')

  // ─── Tradier helpers ──────────────────────────────────────────────────────
  // Phase 2: prefer Clerk JWT (admin key). Fall back to user token for sandbox testing.
  const tGet = useCallback(async (path) => {
    const authToken = await getAuthToken().catch(()=>null)
    return tradierGet(path, tradierToken, tradierMode, authToken)
  }, [tradierToken, tradierMode, getAuthToken])
  const getQuote    = async t=>{const d=await tGet(`/markets/quotes?symbols=${t}&greeks=false`);return d?.quotes?.quote||null}
  const getExpiries = async t=>{const d=await tGet(`/markets/options/expirations?symbol=${t}&includeAllRoots=false`);return d?.expirations?.date||[]}
  const getChain    = async(t,e)=>{const d=await tGet(`/markets/options/chains?symbol=${t}&expiration=${e}&greeks=true`);return d?.options?.option||[]}

  // ─── Price bar fetch ──────────────────────────────────────────────────────
  // Direct fetch — avoids stale closure issues with useCallback chains
  const fetchPriceBar = useCallback(async()=>{
    setBarLoading(true)

    const directQuote = async (sym) => {
      try {
        // Get auth token fresh on every call
        const authToken = await getAuthToken().catch(()=>null)
        const headers = {}
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`
        else if (tradierToken) { headers['x-tradier-token']=tradierToken; headers['x-tradier-mode']=tradierMode }

        const path = `/markets/quotes?symbols=${sym}&greeks=false`
        const res  = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, { headers })
        if (!res.ok) { console.warn(`Quote ${sym}: HTTP ${res.status}`); return null }
        const data = await res.json()
        const q = data?.quotes?.quote
        if (!q) { console.warn(`Quote ${sym}: no quote in response`, data); return null }
        const last  = parseFloat(q.last      || 0)
        const close = parseFloat(q.close     || 0)
        const prev  = parseFloat(q.prevclose || 0)
        // Prefer last if it differs from prevclose (i.e. not stale pre-market)
        // Fall back to close, then prevclose
        const p = (last > 0 && last !== prev) ? last : (close > 0 ? close : prev)
        if (p <= 0) { console.warn(`Quote ${sym}: price is 0`, q); return null }
        return { price:p, chgPct:parseFloat(q.change_percentage||0), chg:parseFloat(q.change||0), sym, q }
      } catch(e) {
        console.warn(`Quote ${sym} failed:`, e.message)
        return null
      }
    }

    // Try index first, ETF as fallback (SPX preferred over SPY, NDX over QQQ)
    let es = null, nq = null
    for (const sym of ['SPX','$SPX.X','SPY']) {
      es = await directQuote(sym)
      if (es) break
    }
    for (const sym of ['NDX','$NDX.X','QQQ']) {
      nq = await directQuote(sym)
      if (nq) break
    }

    if (es) setEsBar({...es, label: es.sym==='SPY'?'SPY':es.sym==='SPX'?'SPX':'SPX'})
    if (nq) setNqBar({...nq, label: nq.sym==='QQQ'?'QQQ':nq.sym==='NDX'?'NDX':'NDX'})

    if (es) {
      const spxChg = es.chgPct
      const ndxChg = nq?.chgPct || spxChg
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
      setMarketConviction({ score:bull, direction:dir, spxChg, ndxChg,
        color: dir==='BULLISH'?C.green:dir==='BEARISH'?C.red:C.orange })
    }
    setLastRefreshed(Date.now())
    setNextRefresh(30)
    setBarLoading(false)
  },[tradierToken, tradierMode, getAuthToken])

  // Run on mount only — fetchPriceBar already captures getAuthToken via closure
  useEffect(()=>{ fetchPriceBar() },[])
  // ── Auto-refresh price bar every 30s when tab is visible ──────────────────
useEffect(() => {
  const tick = () => {
    if (document.visibilityState === 'visible') fetchPriceBar()
  }
  const interval = setInterval(tick, 30_000)
  document.addEventListener('visibilitychange', tick)
  return () => {
    clearInterval(interval)
    document.removeEventListener('visibilitychange', tick)
  }
}, [fetchPriceBar])

  // ── Countdown ticker (1s) ─────────────────────────────────────────────────
  useEffect(() => {
    const countdown = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      setNextRefresh(prev => prev <= 1 ? 30 : prev - 1)
    }, 1_000)
    return () => clearInterval(countdown)
  }, [])

  // ─── Single ticker scan ───────────────────────────────────────────────────
  const runScan = async()=>{
    if (!scanTicker.trim()) return
    const log=[];

module.exports = { SP500 }
