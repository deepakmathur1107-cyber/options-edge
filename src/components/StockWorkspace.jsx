import { useCallback, useEffect, useMemo, useState } from 'react'

const STOCKS = [
  { symbol:'NVDA', name:'NVIDIA', sector:'Semiconductors', price:176.26, change:1.84, score:92, setup:'Breakout watch', stage:'WAIT', entry:'177.50–179.00', stop:169.80, target1:188, target2:198, rr:'2.4×', trend:'Strong', rsi:62, volume:'1.4×', support:169.80, resistance:178.20, thesis:'AI infrastructure demand and accelerating data-center revenue keep relative strength near the top of the large-cap universe.', catalyst:'Earnings in 24 days', risk:'Extended valuation; a loss of the 20-day average weakens the setup.', quality:94, growth:98, value:61, momentum:96 },
  { symbol:'AMZN', name:'Amazon', sector:'Consumer / Cloud', price:234.91, change:0.72, score:88, setup:'Pullback entry', stage:'READY', entry:'232.00–235.00', stop:226.40, target1:246, target2:255, rr:'2.7×', trend:'Strong', rsi:55, volume:'1.1×', support:231.60, resistance:241.20, thesis:'AWS margin expansion and advertising growth support a constructive trend after an orderly pullback.', catalyst:'Cloud conference this week', risk:'Consumer slowdown or a close below the rising 50-day average.', quality:91, growth:90, value:72, momentum:86 },
  { symbol:'GOOGL', name:'Alphabet', sector:'Communication', price:208.33, change:-0.38, score:84, setup:'Base breakout', stage:'WAIT', entry:'211.00–212.50', stop:202.70, target1:224, target2:232, rr:'2.1×', trend:'Constructive', rsi:52, volume:'0.9×', support:203.20, resistance:211.10, thesis:'Search durability, improving cloud profitability, and AI product distribution create a balanced quality-growth profile.', catalyst:'Product event in 11 days', risk:'Regulatory headlines and failure to clear the current range.', quality:96, growth:86, value:78, momentum:75 },
  { symbol:'JPM', name:'JPMorgan Chase', sector:'Financials', price:296.48, change:0.44, score:81, setup:'Trend continuation', stage:'READY', entry:'294.00–297.00', stop:287.50, target1:307, target2:316, rr:'2.2×', trend:'Constructive', rsi:58, volume:'1.0×', support:290.20, resistance:299.40, thesis:'Best-in-class execution and resilient net interest income support a steady, lower-volatility trend.', catalyst:'Investor update in 18 days', risk:'Falling yields or credit deterioration could pressure the multiple.', quality:93, growth:68, value:82, momentum:79 },
  { symbol:'COST', name:'Costco', sector:'Consumer Staples', price:1007.84, change:1.09, score:79, setup:'Support bounce', stage:'READY', entry:'998.00–1008.00', stop:976.00, target1:1042, target2:1068, rr:'2.0×', trend:'Constructive', rsi:57, volume:'1.2×', support:991.00, resistance:1024.00, thesis:'Membership renewal strength and pricing power provide defensive growth with unusually consistent execution.', catalyst:'Monthly sales next week', risk:'Premium valuation leaves little room for a soft sales print.', quality:98, growth:75, value:48, momentum:77 },
]

const stageColor = (stage, C) => stage === 'READY' ? C.green : C.orange

const asArray = value => !value ? [] : Array.isArray(value) ? value : [value]
const fmtDate = date => date.toISOString().slice(0, 10)
const authHeaders = async getToken => {
  const token = await getToken?.()
  return token ? { Authorization:`Bearer ${token}` } : {}
}
const rsi14 = closes => {
  if (closes.length < 15) return null
  let gains=0, losses=0
  for (let i=closes.length-14;i<closes.length;i++) {
    const move=closes[i]-closes[i-1]
    if (move>=0) gains+=move
    else losses-=move
  }
  if (!losses) return 100
  return Math.round(100-(100/(1+(gains/14)/(losses/14))))
}
const analyzeBars = bars => {
  if (!bars.length) return null
  const recent=bars.slice(-20)
  const closes=bars.map(b=>Number(b.close)).filter(Number.isFinite)
  const avgVol=recent.reduce((sum,b)=>sum+(Number(b.volume)||0),0)/Math.max(1,recent.length)
  const last=recent[recent.length-1]
  const support=Math.min(...recent.slice(-10).map(b=>Number(b.low)).filter(Number.isFinite))
  const resistance=Math.max(...recent.slice(-10).map(b=>Number(b.high)).filter(Number.isFinite))
  const sma20=recent.reduce((sum,b)=>sum+Number(b.close),0)/Math.max(1,recent.length)
  return { rsi:rsi14(closes), support, resistance, sma20, volumeRatio:avgVol?Number(last?.volume||0)/avgVol:null }
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

export default function StockWorkspace({ C, getToken }) {
  const [selected, setSelected] = useState('AMZN')
  const [filter, setFilter] = useState('ALL')
  const [query, setQuery] = useState('')
  const [paperTrades, setPaperTrades] = useState([])
  const [watchlist, setWatchlist] = useState(['NVDA','AMZN'])
  const [capital, setCapital] = useState(10000)
  const [quotes, setQuotes] = useState({})
  const [technicals, setTechnicals] = useState({})
  const [fundamentals, setFundamentals] = useState({})
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const [tradeMessage, setTradeMessage] = useState('')

  const fetchQuotes = useCallback(async()=>{
    setDataError('')
    try {
      const headers=await authHeaders(getToken)
      const symbols=STOCKS.map(s=>s.symbol).join(',')
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
  },[getToken])

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
        const end=new Date(), start=new Date(Date.now()-120*86400000)
        const historyPath=`/markets/history?symbol=${selected}&interval=daily&start=${fmtDate(start)}&end=${fmtDate(end)}`
        const [historyRes,fundRes]=await Promise.all([
          fetch(`/api/tradier?path=${encodeURIComponent(historyPath)}`,{headers}),
          fetch(`/api/tradier?fundamentals=${encodeURIComponent(selected)}`,{headers}),
        ])
        const history=await historyRes.json()
        const fund=await fundRes.json()
        if(!historyRes.ok) throw new Error(history.error||'Price history unavailable')
        if(!cancelled) {
          setTechnicals(p=>({...p,[selected]:analyzeBars(asArray(history?.history?.day))}))
          if(fundRes.ok&&fund?.available) setFundamentals(p=>({...p,[selected]:fund}))
        }
      } catch(e) { if(!cancelled) setDataError(e.message) }
      finally { if(!cancelled) setDetailLoading(false) }
    }
    loadDetail()
    return()=>{cancelled=true}
  },[selected,getToken])

  const enriched = useMemo(()=>STOCKS.map(seed=>{
    const q=quotes[seed.symbol]
    const t=technicals[seed.symbol]
    const price=Number(q?.last ?? seed.price)
    const change=Number(q?.change_percentage ?? seed.change)
    const support=Number.isFinite(t?.support)?t.support:seed.support
    const resistance=Number.isFinite(t?.resistance)?t.resistance:seed.resistance
    const trend=Number.isFinite(t?.sma20)?(price>t.sma20?'Above 20-day':'Below 20-day'):seed.trend
    const momentum=Number.isFinite(t?.rsi)?Math.min(99,Math.max(35,Math.round(50+(t.rsi-50)*1.4))):seed.momentum
    const score=Math.round(Math.min(96,Math.max(45,seed.quality*.32+seed.growth*.18+momentum*.30+(change>0?12:7))))
    const stage=price>=support&&price<=support*1.035&&trend!=='Below 20-day'?'READY':'WAIT'
    const stop=Number((support*.985).toFixed(2))
    const risk=Math.max(.01,price-stop)
    return {...seed,price,change,support,resistance,trend,momentum,score,stage,stop,
      rsi:t?.rsi??seed.rsi,volume:t?.volumeRatio?`${t.volumeRatio.toFixed(1)}×`:seed.volume,
      entry:`${Math.max(support,price*.985).toFixed(2)}–${Math.min(resistance,price*1.01).toFixed(2)}`,
      target1:Number((price+risk*1.5).toFixed(2)),target2:Number((price+risk*2.5).toFixed(2)),
      rr:'2.5×',live:!!q}
  }),[quotes,technicals])
  const stock = enriched.find(s=>s.symbol===selected) || enriched[0]
  const rows = useMemo(()=>enriched.filter(s=>(filter==='ALL'||s.stage===filter)&&(`${s.symbol} ${s.name}`.toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>b.score-a.score),[enriched,filter,query])
  const fund=fundamentals[selected]
  const riskPerShare = Math.max(.01, stock.price-stock.stop)
  const shares = Math.max(1,Math.floor((Number(capital)||0)*.01/riskPerShare))
  const tracked = paperTrades.includes(stock.symbol)
  const togglePaper = async() => {
    if(tracked) {
      setPaperTrades(p=>p.filter(x=>x!==stock.symbol))
      setTradeMessage('Paper tracking stopped. Existing journal entry was preserved.')
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

  return <div className="si stock-workspace">
    <style>{`
      .stock-hero{display:grid;grid-template-columns:1.5fr .8fr;gap:16px}.stock-body{display:grid;grid-template-columns:minmax(310px,.8fr) minmax(0,1.7fr);gap:16px;align-items:start}.stock-detail-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.stock-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
      @media(max-width:900px){.stock-hero,.stock-body,.stock-detail-grid{grid-template-columns:1fr}.stock-metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.stock-workspace{margin:0 -12px}}
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
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow}}><div style={{fontSize:10,color:C.dim,letterSpacing:1.3,marginBottom:13}}>MARKET CONDITIONS</div><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}><div><div style={{fontSize:18,fontWeight:800,color:C.green}}>RISK ON</div><div style={{fontSize:10,color:C.dim,marginTop:3}}>Selective buying favored</div></div><div style={{width:44,height:44,borderRadius:'50%',display:'grid',placeItems:'center',border:`4px solid ${C.green}`,fontWeight:800,color:C.text}}>72</div></div><div style={{fontSize:11,color:C.subtext,lineHeight:1.55}}>Breadth is positive, but extended leaders should be bought only at planned levels—not chased.</div></div>
    </div>
    <div className="stock-body">
      <section style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:'hidden',boxShadow:C.shadow}}>
        <div style={{padding:14,borderBottom:`1px solid ${C.border}`}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Opportunity list</strong><span style={{fontSize:9,color:C.dim}}>{rows.length} QUALIFY</span></div><input aria-label="Search stocks" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search symbol or company…" style={{width:'100%',background:C.inputBg,border:`1px solid ${C.border}`,color:C.text,padding:'9px 10px',borderRadius:7,fontSize:11}} /><div style={{display:'flex',gap:6,marginTop:9}}>{['ALL','READY','WAIT'].map(f=><button key={f} onClick={()=>setFilter(f)} style={{border:`1px solid ${filter===f?C.green:C.border}`,background:filter===f?`${C.green}18`:'transparent',color:filter===f?C.green:C.dim,borderRadius:5,padding:'5px 9px',fontSize:9,cursor:'pointer'}}>{f}</button>)}</div></div>
        <div style={{maxHeight:650,overflowY:'auto'}}>{rows.map(s=><button key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{width:'100%',display:'grid',gridTemplateColumns:'1fr auto',gap:10,textAlign:'left',padding:'14px',border:'none',borderBottom:`1px solid ${C.border}`,borderLeft:`3px solid ${selected===s.symbol?C.green:'transparent'}`,background:selected===s.symbol?`${C.green}0d`:'transparent',cursor:'pointer',color:C.text}}><div><div style={{display:'flex',alignItems:'center',gap:7}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>{s.symbol}</strong><span style={{fontSize:9,color:stageColor(s.stage,C)}}>{s.stage}</span>{watchlist.includes(s.symbol)&&<span style={{color:C.orange,fontSize:10}}>★</span>}</div><div style={{fontSize:10,color:C.dim,margin:'3px 0 7px'}}>{s.name} · {s.sector}</div><div style={{fontSize:10,color:C.subtext}}>{s.setup}</div></div><div style={{textAlign:'right'}}><div style={{fontFamily:"'Inter',sans-serif",fontWeight:800}}>${s.price.toFixed(2)}</div><div style={{fontSize:10,color:s.change>=0?C.green:C.red,marginTop:3}}>{s.change>=0?'+':''}{s.change}%</div><div style={{fontSize:10,color:C.green,marginTop:8}}>{s.score} EDGE</div></div></button>)}</div>
      </section>
      <section>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow,marginBottom:14}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:14,flexWrap:'wrap',alignItems:'flex-start'}}><div><div style={{display:'flex',alignItems:'center',gap:9,flexWrap:'wrap'}}><h2 style={{fontFamily:"'Inter',sans-serif",fontSize:26,margin:0}}>{stock.symbol}</h2><span style={{color:C.subtext,fontSize:12}}>{stock.name}</span><span style={{fontSize:9,color:stageColor(stock.stage,C),border:`1px solid ${stageColor(stock.stage,C)}55`,padding:'3px 7px',borderRadius:12}}>{detailLoading?'ANALYZING…':stock.stage==='READY'?'ENTRY ZONE ACTIVE':'WAIT FOR TRIGGER'}</span></div><div style={{fontFamily:"'Inter',sans-serif",fontSize:30,fontWeight:800,marginTop:7}}>${stock.price.toFixed(2)} <span style={{fontSize:12,color:stock.change>=0?C.green:C.red}}>{stock.change>=0?'+':''}{stock.change.toFixed(2)}% today</span></div></div><div style={{display:'flex',gap:7}}><button onClick={()=>toggleWatch(stock.symbol)} style={{background:'transparent',border:`1px solid ${C.border}`,color:watchlist.includes(stock.symbol)?C.orange:C.subtext,borderRadius:7,padding:'9px 11px',fontSize:10,cursor:'pointer'}}>{watchlist.includes(stock.symbol)?'★ WATCHING':'☆ WATCHLIST'}</button><button onClick={togglePaper} disabled={loading||detailLoading} style={{background:tracked?`${C.red}18`:C.green,border:`1px solid ${tracked?C.red:C.green}`,color:tracked?C.red:'#1c1916',borderRadius:7,padding:'9px 13px',fontSize:10,fontWeight:800,cursor:'pointer',opacity:(loading||detailLoading)?.6:1}}>{tracked?'STOP PAPER TRADE':'START PAPER TRADE'}</button></div></div>
          {tradeMessage&&<div style={{marginTop:12,padding:'9px 11px',borderRadius:6,border:`1px solid ${tradeMessage.includes('saved')?C.green:C.border}`,color:tradeMessage.includes('saved')?C.green:C.subtext,fontSize:10}}>{tradeMessage}</div>}
          <div className="stock-metrics" style={{marginTop:16}}><Metric label="EDGE SCORE" value={`${stock.score} / 100`} color={C.green} C={C}/><Metric label="SETUP" value={stock.setup} color={C.blue} C={C}/><Metric label="TREND" value={stock.trend} C={C}/><Metric label="REWARD / RISK" value={stock.rr} color={C.green} C={C}/></div>
        </div>
        <div className="stock-detail-grid">
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow,marginBottom:14}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Paper trade playbook</strong>{tracked&&<span style={{fontSize:9,color:C.green}}><span className="pulse">●</span> TRACKING</span>}</div><div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}><Metric label="ENTER ONLY AT" value={stock.entry} color={stageColor(stock.stage,C)} C={C}/><Metric label="HARD STOP" value={`$${stock.stop.toFixed(2)}`} color={C.red} C={C}/><Metric label="TARGET 1 · SELL 50%" value={`$${stock.target1}`} color={C.green} C={C}/><Metric label="TARGET 2 · TRAIL REST" value={`$${stock.target2}`} color={C.green} C={C}/></div><div style={{marginTop:12,padding:'11px 12px',borderRadius:7,background:`${C.orange}0d`,border:`1px solid ${C.orange}35`,fontSize:10,color:C.subtext,lineHeight:1.55}}><strong style={{color:C.orange}}>DO NOT CHASE:</strong> If price opens above the entry zone, wait for a retest. Cancel the plan after a daily close below ${stock.support.toFixed(2)}.</div><div style={{marginTop:14,display:'flex',alignItems:'end',gap:10,flexWrap:'wrap'}}><label style={{fontSize:9,color:C.dim,letterSpacing:1}}>PAPER ACCOUNT<input type="number" value={capital} min="1000" step="1000" onChange={e=>setCapital(e.target.value)} style={{display:'block',width:135,marginTop:5,background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:6,color:C.text,padding:'8px 9px'}}/></label><div style={{fontSize:11,color:C.subtext,paddingBottom:7}}>At 1% risk: <strong style={{color:C.text}}>{shares} shares</strong> · max planned loss <strong style={{color:C.red}}>${(shares*riskPerShare).toFixed(0)}</strong></div></div></div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Why it made the list</strong><p style={{fontFamily:"'Inter',sans-serif",fontSize:12,color:C.subtext,lineHeight:1.7,margin:'12px 0'}}>{stock.thesis}</p>{[['SECTOR',fund?.sector||stock.sector,C.blue],['INDUSTRY',fund?.industry||'Classification unavailable',C.blue],['EARNINGS',fund?.earnings_date||'Date not currently available',C.orange],['KEY RISK',stock.risk,C.red]].map(([l,v,c])=><div key={l} style={{display:'grid',gridTemplateColumns:'80px 1fr',gap:9,padding:'10px 0',borderTop:`1px solid ${C.border}`,fontSize:10,lineHeight:1.55}}><span style={{color:c}}>{l}</span><span style={{color:C.subtext}}>{v}</span></div>)}</div>
          </div>
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow,marginBottom:14}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Technical snapshot</strong><div style={{height:130,margin:'17px 0 12px',position:'relative',borderBottom:`1px solid ${C.border}`,background:`linear-gradient(180deg,${C.green}08,transparent)`}}><div style={{position:'absolute',left:0,right:0,top:'24%',borderTop:`1px dashed ${C.red}80`}}><span style={{float:'right',fontSize:8,color:C.red,background:C.card}}>R {stock.resistance}</span></div><div style={{position:'absolute',left:0,right:0,top:'75%',borderTop:`1px dashed ${C.green}80`}}><span style={{float:'right',fontSize:8,color:C.green,background:C.card}}>S {stock.support}</span></div><div style={{position:'absolute',left:'3%',right:'3%',bottom:'22%',height:55,borderTop:`3px solid ${C.blue}`,borderRadius:'50%',transform:'rotate(-7deg)'}} />{[18,30,43,57,70,82].map((x,i)=><div key={x} style={{position:'absolute',left:`${x}%`,bottom:`${24+i*7}%`,width:5,height:18+i*2,background:i%2?C.red:C.green,borderRadius:2}} />)}</div><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}><Metric label="RSI (14)" value={stock.rsi} color={stock.rsi>68?C.orange:C.text} C={C}/><Metric label="VOLUME" value={stock.volume} C={C}/><Metric label="SUPPORT" value={`$${stock.support.toFixed(2)}`} color={C.green} C={C}/><Metric label="RESISTANCE" value={`$${stock.resistance.toFixed(2)}`} color={C.red} C={C}/></div></div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,boxShadow:C.shadow}}><strong style={{fontFamily:"'Inter',sans-serif",fontSize:14}}>Investment scorecard</strong><div style={{marginTop:16}}><Bar label="Business quality" value={stock.quality} C={C}/><Bar label="Earnings growth" value={stock.growth} C={C}/><Bar label="Valuation" value={stock.value} C={C}/><Bar label="Live price momentum" value={stock.momentum} C={C}/></div><div style={{fontSize:9,color:C.dim,lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:10}}>Momentum, support, resistance, RSI, volume and trade levels are recalculated from market data. Quality, growth and valuation remain model inputs pending a richer fundamentals feed. Scores are not forecasts.</div></div>
          </div>
        </div>
      </section>
    </div>
  </div>
}
