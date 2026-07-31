import { useCallback, useEffect, useMemo, useState } from 'react'
import { analyzeFundamentalHealth, analyzeStockBars, buildStockTradePlan, isBullishScannerRow } from '../lib/stockAnalysis'

const STOCKS = [
  { symbol:'NVDA', name:'NVIDIA', sector:'Semiconductors', price:176.26, change:1.84, score:92, setup:'Breakout watch', stage:'WAIT', entry:'177.50–179.00', stop:169.80, target1:188, target2:198, rr:'2.4×', trend:'Strong', rsi:62, volume:'1.4×', support:169.80, resistance:178.20, thesis:'AI infrastructure demand and accelerating data-center revenue keep relative strength near the top of the large-cap universe.', catalyst:'Earnings in 24 days', risk:'Extended valuation; a loss of the 20-day average weakens the setup.', quality:94, growth:98, value:61, momentum:96 },
  { symbol:'AMZN', name:'Amazon', sector:'Consumer / Cloud', price:234.91, change:0.72, score:88, setup:'Pullback entry', stage:'READY', entry:'232.00–235.00', stop:226.40, target1:246, target2:255, rr:'2.7×', trend:'Strong', rsi:55, volume:'1.1×', support:231.60, resistance:241.20, thesis:'AWS margin expansion and advertising growth support a constructive trend after an orderly pullback.', catalyst:'Cloud conference this week', risk:'Consumer slowdown or a close below the rising 50-day average.', quality:91, growth:90, value:72, momentum:86 },
  { symbol:'GOOGL', name:'Alphabet', sector:'Communication', price:208.33, change:-0.38, score:84, setup:'Base breakout', stage:'WAIT', entry:'211.00–212.50', stop:202.70, target1:224, target2:232, rr:'2.1×', trend:'Constructive', rsi:52, volume:'0.9×', support:203.20, resistance:211.10, thesis:'Search durability, improving cloud profitability, and AI product distribution create a balanced quality-growth profile.', catalyst:'Product event in 11 days', risk:'Regulatory headlines and failure to clear the current range.', quality:96, growth:86, value:78, momentum:75 },
  { symbol:'JPM', name:'JPMorgan Chase', sector:'Financials', price:296.48, change:0.44, score:81, setup:'Trend continuation', stage:'READY', entry:'294.00–297.00', stop:287.50, target1:307, target2:316, rr:'2.2×', trend:'Constructive', rsi:58, volume:'1.0×', support:290.20, resistance:299.40, thesis:'Best-in-class execution and resilient net interest income support a steady, lower-volatility trend.', catalyst:'Investor update in 18 days', risk:'Falling yields or credit deterioration could pressure the multiple.', quality:93, growth:68, value:82, momentum:79 },
  { symbol:'COST', name:'Costco', sector:'Consumer Staples', price:1007.84, change:1.09, score:79, setup:'Support bounce', stage:'READY', entry:'998.00–1008.00', stop:976.00, target1:1042, target2:1068, rr:'2.0×', trend:'Constructive', rsi:57, volume:'1.2×', support:991.00, resistance:1024.00, thesis:'Membership renewal strength and pricing power provide defensive growth with unusually consistent execution.', catalyst:'Monthly sales next week', risk:'Premium valuation leaves little room for a soft sales print.', quality:98, growth:75, value:48, momentum:77 },
]
const DEFAULT_TOP_10 = ['NVDA','AMZN','GOOGL','JPM','COST','AAPL','MSFT','META','AVGO','LLY']
const makeSeed = (symbol, scan={}) => {
  const known=STOCKS.find(s=>s.symbol===symbol)
  if(known) return {...known,scannerScore:Number(scan.score)||known.score,sector:scan.sector||known.sector}
  return {
    symbol,name:symbol,sector:scan.sector||'Sector pending',price:0,change:0,
    score:Number(scan.score)||65,scannerScore:Number(scan.score)||65,
    setup:scan.trade_type?`${scan.trade_type} scanner leader`:'Technical analysis',
    stage:'WAIT',entry:'—',stop:0,target1:0,target2:0,rr:'2.5×',trend:'Analyzing',
    rsi:50,volume:'—',support:0,resistance:0,
    thesis:`${symbol} was identified by the Options Edge scanner. Review its live technical structure, company fundamentals, and risk plan below.`,
    risk:'Wait for complete live history and a valid entry trigger before simulating a position.',
    quality:75,growth:75,value:65,momentum:70,
  }
}

const stageColor = (stage, C) => /QUALITY \+ READY|HEALTHY|ACCEPTABLE/.test(stage) ? C.green : /RISK/.test(stage) ? C.red : /WAIT/.test(stage) ? C.orange : C.dim

const asArray = value => !value ? [] : Array.isArray(value) ? value : [value]
const fmtDate = date => date.toISOString().slice(0, 10)
const authHeaders = async getToken => {
  const token = await getToken?.()
  return token ? { Authorization:`Bearer ${token}` } : {}
}

function Metric({ label, value, color, C }) {
  return <div style={{padding:'11px 12px',background:C.cardAlt,border:`1px solid ${C.border}`,borderRadius:8}}>
    <div style={{fontSize:9,color:C.dim,letterSpacing:1.2,marginBottom:5}}>{label}</div>
    <div style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:700,color:color||C.text}}>{value}</div>
  </div>
}

function Bar({ label, value, C }) {
  const color=value>=85?C.green:value>=70?C.blue:C.orange
  return <div style={{marginBottom:12}}>
    <div style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:5}}><span style={{color:C.subtext}}>{label}</span><span style={{color,fontWeight:700}}>{value}</span></div>
    <div style={{height:5,background:C.border,borderRadius:5,overflow:'hidden'}}><div style={{height:'100%',width:`${value}%`,background:color,borderRadius:5}} /></div>
  </div>
}

function PriceChart({ bars, symbol, C, loading }) {
  const model=useMemo(()=>{
    const clean=asArray(bars).map(bar=>({
      date:bar.date,
      close:Number(bar.close),
    })).filter(point=>point.date&&Number.isFinite(point.close)&&point.close>0)
    if(clean.length<2) return null
    const width=900,height=300,pad={top:22,right:18,bottom:30,left:54}
    const closes=clean.map(point=>point.close)
    const min=Math.min(...closes),max=Math.max(...closes),span=Math.max(.01,max-min)
    const x=index=>pad.left+(index/(clean.length-1))*(width-pad.left-pad.right)
    const y=value=>pad.top+((max-value)/span)*(height-pad.top-pad.bottom)
    const line=clean.map((point,index)=>`${index?'L':'M'}${x(index).toFixed(1)},${y(point.close).toFixed(1)}`).join(' ')
    const averagePath=period=>{
      const points=[]
      let sum=0
      clean.forEach((point,index)=>{
        sum+=point.close
        if(index>=period) sum-=clean[index-period].close
        if(index>=period-1) points.push({index,value:sum/period})
      })
      return points.map((point,index)=>`${index?'L':'M'}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
    }
    const first=clean[0],last=clean[clean.length-1]
    const changePct=(last.close/first.close-1)*100
    const ticks=[max,max-span*.25,max-span*.5,max-span*.75,min]
    const dateTicks=[0,Math.floor((clean.length-1)*.25),Math.floor((clean.length-1)*.5),Math.floor((clean.length-1)*.75),clean.length-1]
    return {width,height,pad,clean,line,sma50:averagePath(50),sma200:averagePath(200),min,max,last,changePct,ticks,dateTicks,x,y}
  },[bars])
  if(!model) return <div className="stock-chart-empty" style={{height:260,display:'grid',placeItems:'center',color:C.dim,fontSize:11,border:`1px dashed ${C.border}`,borderRadius:9}}>{loading?'LOADING 2-YEAR DAILY HISTORY…':'DAILY HISTORY IS NOT AVAILABLE'}</div>
  const positive=model.changePct>=0
  return <div>
    <div className="stock-chart-head" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:12,flexWrap:'wrap',marginBottom:12}}>
      <div><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>{symbol} price history</strong><div style={{fontSize:9,color:C.dim,marginTop:4}}>1 DAY BARS · 2 YEAR DURATION · adjusted market history</div></div>
      <div style={{textAlign:'right'}}><div style={{fontSize:20,fontWeight:800,color:positive?C.green:C.red}}>{positive?'+':''}{model.changePct.toFixed(1)}%</div><div style={{fontSize:9,color:C.dim}}>2-YEAR PRICE CHANGE</div></div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:7,marginBottom:10}}>
      <Metric label="LATEST CLOSE" value={`$${model.last.close.toFixed(2)}`} C={C}/>
      <Metric label="2Y HIGH" value={`$${model.max.toFixed(2)}`} color={C.green} C={C}/>
      <Metric label="2Y LOW" value={`$${model.min.toFixed(2)}`} color={C.orange} C={C}/>
    </div>
    <div className="stock-chart-scroll" style={{width:'100%',overflow:'hidden',border:`1px solid ${C.border}`,borderRadius:9,background:`linear-gradient(180deg,${C.green}08,transparent)`}}>
      <svg role="img" aria-label={`${symbol} daily closing price chart for the last two years`} viewBox={`0 0 ${model.width} ${model.height}`} style={{display:'block',width:'100%',height:'auto',minHeight:220}}>
        {model.ticks.map((tick,index)=><g key={tick}><line x1={model.pad.left} x2={model.width-model.pad.right} y1={model.y(tick)} y2={model.y(tick)} stroke={C.border} strokeWidth="1"/><text x={model.pad.left-8} y={model.y(tick)+4} textAnchor="end" fontSize="10" fill={C.dim}>${tick.toFixed(0)}</text></g>)}
        {model.dateTicks.map(index=><text key={index} x={model.x(index)} y={model.height-9} textAnchor={index===0?'start':index===model.clean.length-1?'end':'middle'} fontSize="10" fill={C.dim}>{new Date(`${model.clean[index].date}T12:00:00`).toLocaleDateString([], {month:'short',year:'2-digit'})}</text>)}
        <path d={model.line} fill="none" stroke={positive?C.green:C.red} strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>
        {model.sma50&&<path d={model.sma50} fill="none" stroke={C.blue} strokeWidth="1.5" opacity=".9" vectorEffect="non-scaling-stroke"/>}
        {model.sma200&&<path d={model.sma200} fill="none" stroke={C.orange} strokeWidth="1.5" opacity=".9" vectorEffect="non-scaling-stroke"/>}
        <circle cx={model.x(model.clean.length-1)} cy={model.y(model.last.close)} r="4" fill={positive?C.green:C.red}/>
      </svg>
    </div>
    <div style={{display:'flex',gap:14,flexWrap:'wrap',marginTop:9,fontSize:9,color:C.dim}}><span><b style={{color:positive?C.green:C.red}}>━</b> DAILY CLOSE</span><span><b style={{color:C.blue}}>━</b> 50-DAY AVG</span><span><b style={{color:C.orange}}>━</b> 200-DAY AVG</span></div>
  </div>
}

export default function StockWorkspace({ C, getToken }) {
  const [selected, setSelected] = useState('AMZN')
  const [filter, setFilter] = useState('ALL')
  const [query, setQuery] = useState('')
  const [paperTrades, setPaperTrades] = useState([])
  const [watchlist, setWatchlist] = useState(['NVDA','AMZN'])
  const [capital, setCapital] = useState(10000)
  const [quotes, setQuotes] = useState({})
  const [technicals, setTechnicals] = useState({})
  const [priceHistory, setPriceHistory] = useState({})
  const [fundamentals, setFundamentals] = useState({})
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const [tradeMessage, setTradeMessage] = useState('')
  const [topStocks, setTopStocks] = useState(()=>DEFAULT_TOP_10.map(symbol=>makeSeed(symbol)))
  const [topSource, setTopSource] = useState({kind:'fallback',label:'Curated fallback · live scanner results unavailable'})
  const [batchLoading, setBatchLoading] = useState(false)
  const [manualStocks, setManualStocks] = useState([])
  const [tickerInput, setTickerInput] = useState('')
  const [tickerError, setTickerError] = useState('')
  const universe=useMemo(()=>{
    const merged=[...manualStocks,...topStocks]
    return merged.filter((item,index)=>merged.findIndex(x=>x.symbol===item.symbol)===index)
  },[topStocks,manualStocks])

  useEffect(()=>{
    let cancelled=false
    const loadTopTen=async()=>{
      try {
        const headers=await authHeaders(getToken)
        const res=await fetch('/api/scan-cache?minScore=60',{headers})
        const data=await res.json()
        if(!res.ok||!Array.isArray(data.results)) return
        const unique=[]
        for(const row of data.results) {
          if(!isBullishScannerRow(row)) continue
          const symbol=String(row.ticker||'').toUpperCase()
          if(symbol&&!unique.some(x=>x.symbol===symbol)) unique.push(makeSeed(symbol,row))
          if(unique.length===10) break
        }
        if(!cancelled&&unique.length) {
          setTopStocks(unique)
          setTopSource({kind:'live',label:`Bullish scanner candidates · refreshed ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`})
          setSelected(current=>unique.some(item=>item.symbol===current)?current:unique[0].symbol)
        }
      } catch {}
    }
    loadTopTen()
    return()=>{cancelled=true}
  },[getToken])

  useEffect(()=>{
    let cancelled=false
    const loadBatchTechnicals=async()=>{
      setBatchLoading(true)
      const headers=await authHeaders(getToken)
      const end=new Date(),start=new Date(Date.now()-240*86400000)
      const next={}
      for(let index=0;index<topStocks.length;index+=3) {
        const group=topStocks.slice(index,index+3)
        await Promise.all(group.map(async item=>{
          try {
            const path=`/markets/history?symbol=${item.symbol}&interval=daily&start=${fmtDate(start)}&end=${fmtDate(end)}`
            const res=await fetch(`/api/tradier?path=${encodeURIComponent(path)}`,{headers})
            const data=await res.json()
            next[item.symbol]=res.ok?analyzeStockBars(asArray(data?.history?.day)):{status:'INSUFFICIENT_DATA',reason:data.error||'History unavailable.'}
          } catch(e) { next[item.symbol]={status:'INSUFFICIENT_DATA',reason:e.message} }
        }))
        if(cancelled) return
      }
      if(!cancelled) setTechnicals(previous=>({...previous,...next}))
      if(!cancelled) setBatchLoading(false)
    }
    if(topStocks.length) loadBatchTechnicals()
    return()=>{cancelled=true}
  },[topStocks,getToken])

  useEffect(()=>{
    let cancelled=false
    const loadBatchFundamentals=async()=>{
      const headers=await authHeaders(getToken)
      const next={}
      for(let index=0;index<topStocks.length;index+=3) {
        const group=topStocks.slice(index,index+3)
        await Promise.all(group.map(async item=>{
          try {
            const res=await fetch(`/api/tradier?fundamentals=${encodeURIComponent(item.symbol)}`,{headers})
            const data=await res.json()
            if(res.ok&&data?.available) next[item.symbol]=data
          } catch {}
        }))
        if(cancelled) return
      }
      if(!cancelled) setFundamentals(previous=>({...previous,...next}))
    }
    if(topStocks.length) loadBatchFundamentals()
    return()=>{cancelled=true}
  },[topStocks,getToken])

  const fetchQuotes = useCallback(async()=>{
    setDataError('')
    try {
      const headers=await authHeaders(getToken)
      const symbols=[...new Set([...universe.map(s=>s.symbol),'SPY','QQQ'])].join(',')
      const path=`/markets/quotes?symbols=${symbols}&greeks=false`
      const res=await fetch(`/api/tradier?path=${encodeURIComponent(path)}`,{headers})
      const data=await res.json()
      if(!res.ok) throw new Error(data.error||`Quote request failed (${res.status})`)
      const next={}
      asArray(data?.quotes?.quote).forEach(q=>{ if(q?.symbol) next[q.symbol]=q })
      if(!Object.keys(next).length) throw new Error('No stock quotes were returned')
      setQuotes(next)
      setUpdatedAt(new Date())
    } catch(e) { setDataError(e.message) }
    finally { setLoading(false) }
  },[getToken,universe])

  useEffect(()=>{
    fetchQuotes()
    const timer=setInterval(fetchQuotes,30000)
    return()=>clearInterval(timer)
  },[fetchQuotes])

  useEffect(()=>{
    let cancelled=false
    const loadDetail=async()=>{
      setDetailLoading(true)
      try {
        const headers=await authHeaders(getToken)
        const end=new Date(), start=new Date(Date.now()-730*86400000)
        const historyPath=`/markets/history?symbol=${selected}&interval=daily&start=${fmtDate(start)}&end=${fmtDate(end)}`
        const [historyRes,fundRes]=await Promise.all([
          fetch(`/api/tradier?path=${encodeURIComponent(historyPath)}`,{headers}),
          fetch(`/api/tradier?fundamentals=${encodeURIComponent(selected)}`,{headers}),
        ])
        const history=await historyRes.json()
        const fund=await fundRes.json()
        if(!historyRes.ok) throw new Error(history.error||'Price history unavailable')
        if(!cancelled) {
          const dailyBars=asArray(history?.history?.day)
          setPriceHistory(p=>({...p,[selected]:dailyBars}))
          setTechnicals(p=>({...p,[selected]:analyzeStockBars(dailyBars)}))
          if(fundRes.ok&&fund?.available) setFundamentals(p=>({...p,[selected]:fund}))
        }
      } catch(e) { if(!cancelled) setDataError(e.message) }
      finally { if(!cancelled) setDetailLoading(false) }
    }
    loadDetail()
    return()=>{cancelled=true}
  },[selected,getToken])

  const enriched = useMemo(()=>universe.map(seed=>{
    const q=quotes[seed.symbol]
    const t=technicals[seed.symbol]
    const price=Number(q?.last ?? seed.price)
    const change=Number(q?.change_percentage ?? seed.change)
    const analyzed=t&&t.status!=='INSUFFICIENT_DATA'
    const support=analyzed?t.support:null
    const resistance=analyzed?t.resistance:null
    const trend=analyzed?(t.trendUp?'20D > 50D uptrend':'Bullish alignment absent'):'Analysis pending'
    const momentum=Number.isFinite(t?.rsi)?Math.min(99,Math.max(35,Math.round(50+(t.rsi-50)*1.4))):null
    const technicalScore=t?.technicalScore??null
    const score=technicalScore==null?null:topSource.kind==='live'&&seed.scannerScore?Math.round((technicalScore+seed.scannerScore)/2):technicalScore
    const health=analyzeFundamentalHealth(fundamentals[seed.symbol])
    const technicalStage=!t?'ANALYZING':t.status==='INSUFFICIENT_DATA'?'INSUFFICIENT DATA':t.status
    const healthPassed=health.status==='HEALTHY'||health.status==='ACCEPTABLE'
    const stage=technicalStage==='ANALYZING'||technicalStage==='INSUFFICIENT DATA'?technicalStage
      :!healthPassed?health.label
      :technicalStage==='READY'?'QUALITY + READY':'QUALITY + WAIT'
    const plan=technicalStage==='READY'&&healthPassed?buildStockTradePlan({price,analysis:t}):null
    return {...seed,price,change,support,resistance,trend,momentum,technicalScore,score,stage,technicalStage,health,analysisReason:t?.reason||'Technical history is still loading.',plan,
      setup:analyzed?t.setup:seed.setup,stop:plan?.stop??null,
      rsi:t?.rsi??seed.rsi,volume:t?.volumeRatio?`${t.volumeRatio.toFixed(1)}×`:seed.volume,
      entry:plan?`${plan.entryLow.toFixed(2)}–${plan.entryHigh.toFixed(2)}`:'—',
      target1:plan?.target1??null,target2:plan?.target2??null,
      rr:plan?.rr||'—',live:!!q}
  }),[universe,quotes,technicals,fundamentals,topSource.kind])
  const stock = enriched.find(s=>s.symbol===selected) || enriched[0]
  const rows = useMemo(()=>enriched.filter(s=>{
    const filterMatch=filter==='ALL'||s.stage===filter||(filter==='BLOCKED'&&['FUNDAMENTAL RISK','EVENT RISK','DATA INCOMPLETE'].includes(s.stage))
    return filterMatch&&(`${s.symbol} ${s.name}`.toLowerCase().includes(query.toLowerCase()))
  }).sort((a,b)=>Number(b.stage==='QUALITY + READY')-Number(a.stage==='QUALITY + READY')||(b.score??0)-(a.score??0)),[enriched,filter,query])
  const marketState=useMemo(()=>{
    const spy=Number(quotes.SPY?.change_percentage),qqq=Number(quotes.QQQ?.change_percentage)
    if(!Number.isFinite(spy)||!Number.isFinite(qqq)) return {label:'UNAVAILABLE',score:null,color:C.dim,detail:'SPY and QQQ regime data is unavailable.'}
    const average=(spy+qqq)/2
    const score=Math.round(Math.max(0,Math.min(100,50+average*12)))
    if(spy>0&&qqq>0) return {label:'RISK ON',score,color:C.green,detail:`SPY ${spy>=0?'+':''}${spy.toFixed(2)}% · QQQ ${qqq>=0?'+':''}${qqq.toFixed(2)}%`}
    if(spy<0&&qqq<0) return {label:'RISK OFF',score,color:C.red,detail:`SPY ${spy.toFixed(2)}% · QQQ ${qqq.toFixed(2)}%`}
    return {label:'MIXED',score,color:C.orange,detail:`SPY ${spy>=0?'+':''}${spy.toFixed(2)}% · QQQ ${qqq>=0?'+':''}${qqq.toFixed(2)}%`}
  },[quotes,C])
  const fund=fundamentals[selected]
  const riskPerShare = stock.plan?Math.max(.01,stock.plan.entryLow-stock.plan.stop):null
  const shares = riskPerShare?Math.max(1,Math.floor((Number(capital)||0)*.01/riskPerShare)):0
  const tracked = paperTrades.includes(stock.symbol)
  const togglePaper = async() => {
    if(tracked) {
      setPaperTrades(p=>p.filter(x=>x!==stock.symbol))
      setTradeMessage('Paper tracking stopped. Existing journal entry was preserved.')
      return
    }
    if(stock.stage!=='QUALITY + READY'||!stock.plan) {
      setTradeMessage(stock.health?.reasons?.[0]||stock.analysisReason||'Business health and a validated technical setup are required before starting a paper trade.')
      return
    }
    setTradeMessage('Saving paper trade…')
    try {
      const headers={...(await authHeaders(getToken)),'Content-Type':'application/json'}
      const res=await fetch('/api/user/trades',{method:'POST',headers,body:JSON.stringify({
        ticker:stock.symbol,type:'Stock',option_type:'stock',action:'buy',
        contracts:shares,entry_price:stock.price,target:stock.target2,stop:stock.stop,
        status:'Open',strategy:'Long Stock',conviction:stock.score,grade:stock.score>=85?'A':'B',
        notes:`Stocks tab paper trade. Entry zone ${stock.entry}; first target $${stock.target1}. Educational simulation.`,
      })})
      const data=await res.json()
      if(!res.ok) throw new Error(data.error||'Could not save paper trade')
      setPaperTrades(p=>[...p,stock.symbol])
      setTradeMessage(`Paper trade saved: ${shares} ${stock.symbol} shares at $${stock.price.toFixed(2)}.`)
    } catch(e) { setTradeMessage(e.message) }
  }
  const toggleWatch = (symbol) => setWatchlist(p=>p.includes(symbol)?p.filter(x=>x!==symbol):[...p,symbol])
  const analyzeTicker = async(event) => {
    event.preventDefault()
    const symbol=tickerInput.trim().toUpperCase()
    if(!/^[A-Z][A-Z.-]{0,5}$/.test(symbol)) {
      setTickerError('Enter a valid ticker, for example AAPL or BRK.B.')
      return
    }
    setTickerError('')
    setDetailLoading(true)
    try {
      const headers=await authHeaders(getToken)
      const path=`/markets/quotes?symbols=${symbol}&greeks=false`
      const res=await fetch(`/api/tradier?path=${encodeURIComponent(path)}`,{headers})
      const data=await res.json()
      const quote=asArray(data?.quotes?.quote)[0]
      if(!res.ok||!quote?.symbol||!Number(quote.last)) throw new Error('Ticker not found or no live quote is available.')
      setQuotes(p=>({...p,[symbol]:quote}))
      setManualStocks(p=>p.some(s=>s.symbol===symbol)?p:[makeSeed(symbol),...p])
      setSelected(symbol)
      setTickerInput('')
    } catch(e) { setTickerError(e.message) }
    finally { setDetailLoading(false) }
  }

  return <div className="si stock-workspace">
    <style>{`
      .stock-hero{display:grid;grid-template-columns:1.5fr .8fr;gap:16px}.stock-body{display:grid;grid-template-columns:minmax(310px,.8fr) minmax(0,1.7fr);gap:16px;align-items:start}.stock-detail-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.stock-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
      @media(max-width:900px){.stock-hero,.stock-body,.stock-detail-grid{grid-template-columns:1fr}.stock-metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.stock-workspace{margin:0 -12px}.stock-chart-head{align-items:flex-start!important}.stock-chart-head>div:last-child{text-align:left!important}.stock-chart-scroll svg{min-width:560px}.stock-chart-scroll{overflow-x:auto!important;-webkit-overflow-scrolling:touch}.stock-chart-empty{height:210px!important}}
    `}</style>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:14,marginBottom:18,flexWrap:'wrap'}}>
      <div><div style={{fontSize:10,color:C.green,letterSpacing:2,marginBottom:8}}>STOCK INTELLIGENCE</div><h1 style={{fontFamily:"'Inter',sans-serif",fontSize:'clamp(26px,3vw,38px)',lineHeight:1.05,margin:0,color:C.text}}>Find quality. Wait for price.</h1><p style={{fontFamily:"'Inter',sans-serif",fontSize:13,color:C.subtext,lineHeight:1.6,margin:'9px 0 0',maxWidth:680}}>Research strong companies, understand the setup, then rehearse a rules-based entry and exit with paper money.</p></div>
      <div style={{padding:'10px 13px',border:`1px solid ${dataError?C.red:C.green}45`,background:`${dataError?C.red:C.green}0d`,borderRadius:8,maxWidth:330,fontSize:10,color:C.dim,lineHeight:1.55}}>
        <div style={{display:'flex',alignItems:'center',gap:7}}><span style={{width:6,height:6,borderRadius:'50%',background:dataError?C.red:C.green,boxShadow:dataError?'none':`0 0 7px ${C.green}`}} />{loading?'CONNECTING TO MARKET DATA':dataError?'MARKET DATA DEGRADED':'LIVE MARKET DATA'}</div>
        <span style={{color:dataError?C.red:C.subtext}}>{dataError||`Auto-refreshes every 30 seconds${updatedAt?` · updated ${updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:''}`}</span>
        <button onClick={fetchQuotes} disabled={loading} style={{display:'block',marginTop:5,padding:0,border:0,background:'transparent',color:C.blue,fontSize:9,cursor:'pointer'}}>↻ REFRESH NOW</button>
      </div>
    </div>
    <div className="stock-hero" style={{marginBottom:16}}>
      <div style={{background:`linear-gradient(120deg,${C.card},${C.bgDeep})`,border:`1px solid ${C.border}`,borderRadius:12,padding:20,boxShadow:C.shadow}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}><div><div style={{fontSize:9,color:C.dim,letterSpacing:1.4,marginBottom:7}}>HIGHEST-RANKED STOCK SETUP</div><div style={{display:'flex',alignItems:'baseline',gap:10}}><span style={{fontFamily:"'Inter',sans-serif",fontSize:30,fontWeight:800,color:C.text}}>{rows[0]?.symbol||'—'}</span><span style={{fontSize:12,color:C.subtext}}>{rows[0]?.name||'Loading market data'}</span><span style={{fontSize:10,color:stageColor(rows[0]?.stage,C),border:`1px solid ${stageColor(rows[0]?.stage,C)}50`,background:`${stageColor(rows[0]?.stage,C)}12`,padding:'3px 7px',borderRadius:20}}>{rows[0]?.stage||'WAIT'}</span></div><div style={{fontFamily:"'Inter',sans-serif",fontSize:13,color:C.subtext,marginTop:8}}>{rows[0]?.setup||'Analyzing'} · {rows[0]?.trend||'—'} · reward/risk {rows[0]?.rr||'—'}</div></div><div style={{textAlign:'right'}}><div style={{fontSize:34,fontWeight:800,fontFamily:"'Inter',sans-serif",color:C.green}}>{rows[0]?.score||'—'}</div><div style={{fontSize:9,color:C.dim,letterSpacing:1}}>EDGE SCORE</div></div></div>
        <button onClick={()=>rows[0]&&setSelected(rows[0].symbol)} style={{marginTop:17,border:'none',background:C.green,color:'#1c1916',padding:'10px 16px',borderRadius:7,fontWeight:800,fontSize:11,cursor:'pointer'}}>OPEN LIVE TRADE PLAN →</button>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow}}><div style={{fontSize:10,color:C.dim,letterSpacing:1.3,marginBottom:13}}>MARKET CONDITIONS · LIVE INDEX PROXY</div><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}><div><div style={{fontSize:18,fontWeight:800,color:marketState.color}}>{marketState.label}</div><div style={{fontSize:10,color:C.dim,marginTop:3}}>{marketState.detail}</div></div><div style={{width:44,height:44,borderRadius:'50%',display:'grid',placeItems:'center',border:`4px solid ${marketState.color}`,fontWeight:800,color:C.text}}>{marketState.score??'—'}</div></div><div style={{fontSize:11,color:C.subtext,lineHeight:1.55}}>Regime is derived from current SPY and QQQ percentage changes. It is context, not an entry signal.</div></div>
    </div>
    <div className="stock-body">
      <section style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:'hidden',boxShadow:C.shadow}}>
        <div style={{padding:14,borderBottom:`1px solid ${C.border}`}}>
          <div style={{fontSize:9,color:C.green,letterSpacing:1.3,marginBottom:6}}>ANALYZE ANY STOCK</div>
          <form onSubmit={analyzeTicker} style={{display:'grid',gridTemplateColumns:'1fr auto',gap:7}}>
            <input aria-label="Ticker symbol" value={tickerInput} onChange={e=>{setTickerInput(e.target.value.toUpperCase());setTickerError('')}} placeholder="Enter ticker · AAPL" autoCapitalize="characters" style={{width:'100%',background:C.inputBg,border:`1px solid ${tickerError?C.red:C.border}`,color:C.text,padding:'10px 11px',borderRadius:7,fontSize:12,fontWeight:700}} />
            <button type="submit" disabled={detailLoading||!tickerInput.trim()} style={{border:'none',background:C.green,color:'#1c1916',padding:'0 13px',borderRadius:7,fontSize:10,fontWeight:800,cursor:'pointer',opacity:(detailLoading||!tickerInput.trim())?.55:1}}>ANALYZE →</button>
          </form>
          {tickerError&&<div style={{fontSize:9,color:C.red,marginTop:6,lineHeight:1.4}}>{tickerError}</div>}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',margin:'18px 0 10px'}}><div><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Options Edge Top 10</strong><div style={{fontSize:9,color:topSource.kind==='live'?C.green:C.orange,marginTop:3}}>{topSource.label}{batchLoading?' · analyzing all charts…':''}</div></div><span style={{fontSize:9,color:C.dim}}>{topStocks.length} STOCKS</span></div>
          <input aria-label="Filter top stocks" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter this list…" style={{width:'100%',background:C.inputBg,border:`1px solid ${C.border}`,color:C.text,padding:'9px 10px',borderRadius:7,fontSize:11}} />
          <div style={{display:'flex',gap:6,marginTop:9,flexWrap:'wrap'}}>{['ALL','QUALITY + READY','QUALITY + WAIT','BLOCKED'].map(f=><button key={f} onClick={()=>setFilter(f)} style={{border:`1px solid ${filter===f?C.green:C.border}`,background:filter===f?`${C.green}18`:'transparent',color:filter===f?C.green:C.dim,borderRadius:5,padding:'5px 9px',fontSize:9,cursor:'pointer'}}>{f}</button>)}</div>
        </div>
        <div style={{maxHeight:650,overflowY:'auto'}}>{rows.map(s=><button key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{width:'100%',display:'grid',gridTemplateColumns:'1fr auto',gap:10,textAlign:'left',padding:'14px',border:'none',borderBottom:`1px solid ${C.border}`,borderLeft:`3px solid ${selected===s.symbol?C.green:'transparent'}`,background:selected===s.symbol?`${C.green}0d`:'transparent',cursor:'pointer',color:C.text}}><div><div style={{display:'flex',alignItems:'center',gap:7}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>{s.symbol}</strong><span style={{fontSize:9,color:stageColor(s.stage,C)}}>{s.stage}</span>{watchlist.includes(s.symbol)&&<span style={{color:C.orange,fontSize:10}}>★</span>}</div><div style={{fontSize:10,color:C.dim,margin:'3px 0 7px'}}>{s.name} · {s.sector}</div><div style={{fontSize:10,color:C.subtext}}>{s.setup}</div></div><div style={{textAlign:'right'}}><div style={{fontFamily:"'Inter',sans-serif",fontWeight:800}}>${s.price.toFixed(2)}</div><div style={{fontSize:10,color:s.change>=0?C.green:C.red,marginTop:3}}>{s.change>=0?'+':''}{s.change}%</div><div style={{fontSize:10,color:C.green,marginTop:8}}>{s.score} EDGE</div></div></button>)}</div>
      </section>
      <section>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow,marginBottom:14}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:14,flexWrap:'wrap',alignItems:'flex-start'}}><div><div style={{display:'flex',alignItems:'center',gap:9,flexWrap:'wrap'}}><h2 style={{fontFamily:"'Inter',sans-serif",fontSize:26,margin:0}}>{stock.symbol}</h2><span style={{color:C.subtext,fontSize:12}}>{stock.name}</span><span style={{fontSize:9,color:stageColor(stock.stage,C),border:`1px solid ${stageColor(stock.stage,C)}55`,padding:'3px 7px',borderRadius:12}}>{detailLoading?'ANALYZING…':stock.stage}</span></div><div style={{fontFamily:"'Inter',sans-serif",fontSize:30,fontWeight:800,marginTop:7}}>${stock.price.toFixed(2)} <span style={{fontSize:12,color:stock.change>=0?C.green:C.red}}>{stock.change>=0?'+':''}{stock.change.toFixed(2)}% today</span></div><div style={{fontSize:10,color:C.subtext,lineHeight:1.5,marginTop:7,maxWidth:650}}><strong>Technical:</strong> {stock.analysisReason}<br/><strong>Health gate:</strong> {stock.health?.reasons?.[0]}</div></div><div style={{display:'flex',gap:7}}><button onClick={()=>toggleWatch(stock.symbol)} style={{background:'transparent',border:`1px solid ${C.border}`,color:watchlist.includes(stock.symbol)?C.orange:C.subtext,borderRadius:7,padding:'9px 11px',fontSize:10,cursor:'pointer'}}>{watchlist.includes(stock.symbol)?'★ WATCHING':'☆ WATCHLIST'}</button><button onClick={togglePaper} disabled={loading||detailLoading||stock.stage!=='QUALITY + READY'} style={{background:tracked?`${C.red}18`:C.green,border:`1px solid ${tracked?C.red:C.green}`,color:tracked?C.red:'#1c1916',borderRadius:7,padding:'9px 13px',fontSize:10,fontWeight:800,cursor:'pointer',opacity:(loading||detailLoading||stock.stage!=='QUALITY + READY')?.45:1}}>{tracked?'STOP PAPER TRADE':'START PAPER TRADE'}</button></div></div>
          {tradeMessage&&<div style={{marginTop:12,padding:'9px 11px',borderRadius:6,border:`1px solid ${tradeMessage.includes('saved')?C.green:C.border}`,color:tradeMessage.includes('saved')?C.green:C.subtext,fontSize:10}}>{tradeMessage}</div>}
          <div className="stock-metrics" style={{marginTop:16}}><Metric label="EDGE SCORE" value={`${stock.score} / 100`} color={C.green} C={C}/><Metric label="SETUP" value={stock.setup} color={C.blue} C={C}/><Metric label="TREND" value={stock.trend} C={C}/><Metric label="REWARD / RISK" value={stock.rr} color={C.green} C={C}/></div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:'clamp(12px,2vw,18px)',boxShadow:C.shadow,marginBottom:14}}>
          <PriceChart bars={priceHistory[selected]} symbol={stock.symbol} C={C} loading={detailLoading}/>
        </div>
        <div className="stock-detail-grid">
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow,marginBottom:14}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Paper trade playbook</strong>{tracked&&<span style={{fontSize:9,color:C.green}}><span className="pulse">●</span> TRACKING</span>}</div><div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}><Metric label="ENTER ONLY AT" value={stock.entry} color={stageColor(stock.stage,C)} C={C}/><Metric label="HARD STOP" value={stock.stop!=null?`$${stock.stop.toFixed(2)}`:'—'} color={C.red} C={C}/><Metric label="TARGET 1 · SELL 50%" value={stock.target1!=null?`$${stock.target1.toFixed(2)}`:'—'} color={C.green} C={C}/><Metric label="TARGET 2 · TRAIL REST" value={stock.target2!=null?`$${stock.target2.toFixed(2)}`:'—'} color={C.green} C={C}/></div><div style={{marginTop:12,padding:'11px 12px',borderRadius:7,background:`${stock.plan?C.orange:C.dim}0d`,border:`1px solid ${stock.plan?C.orange:C.dim}35`,fontSize:10,color:C.subtext,lineHeight:1.55}}>{stock.plan?<><strong style={{color:C.orange}}>INVALIDATION:</strong> Do not chase beyond the entry range. Exit if the planned stop is reached.</>:<><strong style={{color:C.dim}}>NO ACTIONABLE PLAN:</strong> {stock.analysisReason}</>}</div><div style={{marginTop:14,display:'flex',alignItems:'end',gap:10,flexWrap:'wrap'}}><label style={{fontSize:9,color:C.dim,letterSpacing:1}}>PAPER ACCOUNT<input type="number" value={capital} min="1000" step="1000" onChange={e=>setCapital(e.target.value)} style={{display:'block',width:135,marginTop:5,background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:6,color:C.text,padding:'8px 9px'}}/></label><div style={{fontSize:11,color:C.subtext,paddingBottom:7}}>{riskPerShare?<><span>At 1% risk: </span><strong style={{color:C.text}}>{shares} shares</strong><span> · max planned loss </span><strong style={{color:C.red}}>${(shares*riskPerShare).toFixed(0)}</strong></>:<span>Position sizing appears only after a valid trade plan exists.</span>}</div></div></div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Why it made the list</strong><p style={{fontFamily:"'Inter',sans-serif",fontSize:12,color:C.subtext,lineHeight:1.7,margin:'12px 0'}}>{stock.thesis}</p>{[['SECTOR',fund?.sector||stock.sector,C.blue],['INDUSTRY',fund?.industry||'Classification unavailable',C.blue],['EARNINGS',fund?.earnings_date||'Date not currently available',C.orange],['KEY RISK',stock.risk,C.red]].map(([l,v,c])=><div key={l} style={{display:'grid',gridTemplateColumns:'80px 1fr',gap:9,padding:'10px 0',borderTop:`1px solid ${C.border}`,fontSize:10,lineHeight:1.55}}><span style={{color:c}}>{l}</span><span style={{color:C.subtext}}>{v}</span></div>)}</div>
          </div>
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow,marginBottom:14}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Technical snapshot</strong><div style={{height:130,margin:'17px 0 12px',position:'relative',borderBottom:`1px solid ${C.border}`,background:`linear-gradient(180deg,${C.green}08,transparent)`}}>{stock.resistance!=null&&<div style={{position:'absolute',left:0,right:0,top:'24%',borderTop:`1px dashed ${C.red}80`}}><span style={{float:'right',fontSize:8,color:C.red,background:C.card}}>R {stock.resistance.toFixed(2)}</span></div>}{stock.support!=null&&<div style={{position:'absolute',left:0,right:0,top:'75%',borderTop:`1px dashed ${C.green}80`}}><span style={{float:'right',fontSize:8,color:C.green,background:C.card}}>S {stock.support.toFixed(2)}</span></div>}<div style={{position:'absolute',left:'3%',right:'3%',bottom:'22%',height:55,borderTop:`3px solid ${C.blue}`,borderRadius:'50%',transform:'rotate(-7deg)'}} />{[18,30,43,57,70,82].map((x,i)=><div key={x} style={{position:'absolute',left:`${x}%`,bottom:`${24+i*7}%`,width:5,height:18+i*2,background:i%2?C.red:C.green,borderRadius:2}} />)}</div><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}><Metric label="RSI (14)" value={stock.rsi??'—'} color={stock.rsi>68?C.orange:C.text} C={C}/><Metric label="VOLUME" value={stock.volume} C={C}/><Metric label="SUPPORT" value={stock.support!=null?`$${stock.support.toFixed(2)}`:'—'} color={C.green} C={C}/><Metric label="RESISTANCE" value={stock.resistance!=null?`$${stock.resistance.toFixed(2)}`:'—'} color={C.red} C={C}/></div></div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Evidence scorecard</strong><div style={{marginTop:16}}>{stock.technicalScore!=null?<Bar label="Live technical structure" value={stock.technicalScore} C={C}/>:<div style={{fontSize:11,color:C.dim,marginBottom:12}}>Technical score pending.</div>}{stock.health?.score!=null&&<Bar label="Fundamental health" value={stock.health.score} C={C}/>}<div style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:7,margin:'14px 0'}}><Metric label="HEALTH GATE" value={stock.health?.label||'DATA INCOMPLETE'} color={stageColor(stock.health?.label||'',C)} C={C}/><Metric label="DATA COVERAGE" value={`${stock.health?.coverage||0}%`} color={(stock.health?.coverage||0)>=75?C.blue:C.orange} C={C}/><Metric label="P/E (TTM)" value={stock.health?.metrics?.pe!=null?stock.health.metrics.pe.toFixed(1):'Unavailable'} C={C}/><Metric label="MARKET CAP" value={stock.health?.metrics?.marketCap!=null?`$${(stock.health.metrics.marketCap/1e9).toFixed(1)}B`:'Unavailable'} C={C}/><Metric label="NET MARGIN" value={stock.health?.metrics?.profitMargin!=null?`${stock.health.metrics.profitMargin.toFixed(1)}%`:'Unavailable'} C={C}/><Metric label="REVENUE GROWTH" value={stock.health?.metrics?.revenueGrowth!=null?`${stock.health.metrics.revenueGrowth.toFixed(1)}%`:'Unavailable'} C={C}/><Metric label="DEBT / EQUITY" value={stock.health?.metrics?.debtToEquity!=null?stock.health.metrics.debtToEquity.toFixed(2):'Sector-adjusted / unavailable'} C={C}/><Metric label="CURRENT RATIO" value={stock.health?.metrics?.currentRatio!=null?stock.health.metrics.currentRatio.toFixed(2):'Sector-adjusted / unavailable'} C={C}/></div>{stock.health?.warnings?.map(message=><div key={message} style={{fontSize:10,color:C.orange,lineHeight:1.5,marginTop:5}}>⚠ {message}</div>)}</div><div style={{fontSize:9,color:C.dim,lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:10}}>A stock is labeled QUALITY + READY only when the business-health gate and technical-entry gate both pass. Missing critical fundamentals fail closed.</div></div>
          </div>
        </div>
      </section>
    </div>
  </div>
}
