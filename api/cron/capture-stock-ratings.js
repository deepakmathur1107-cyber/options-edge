const {createClient}=require('@supabase/supabase-js')
const {getFundamentals}=require('../_lib/fundamentals')
const {analyzeStockBars,analyzeFundamentalHealth,buildPlan}=require('../_lib/stockRatingAnalysis')

const VERSION='stock-health-v1'
const BASE=(process.env.TRADIER_MODE||'production')==='sandbox'?'https://sandbox.tradier.com/v1':'https://api.tradier.com/v1'
const HEADERS={Authorization:`Bearer ${process.env.TRADIER_TOKEN||''}`,Accept:'application/json'}
const asArray=value=>!value?[]:Array.isArray(value)?value:[value]
const nyDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const withTimeout=(promise,ms,label)=>Promise.race([
  promise,
  new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} timed out after ${ms}ms`)),ms)),
])
async function tradier(path,maxAttempts=2) {
  let lastError
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    try {
      const response=await withTimeout(fetch(`${BASE}${path}`,{headers:HEADERS}),20000,'Tradier request')
      if(!response.ok) throw new Error(`Tradier ${response.status}`)
      return await response.json()
    } catch(error) {
      lastError=error
      if(attempt<maxAttempts) await wait(400*attempt)
    }
  }
  throw lastError
}
async function collectInBatches(candidates,worker,batchSize=3) {
  const rows=[],failures=[]
  for(let index=0;index<candidates.length;index+=batchSize) {
    const settled=await Promise.all(candidates.slice(index,index+batchSize).map(async candidate=>{
      try { return {row:await worker(candidate)} }
      catch(error) { return {ticker:candidate.ticker,error:error.message||String(error)} }
    }))
    for(const result of settled) {
      if(result.row) rows.push(result.row)
      else if(result.error) failures.push({ticker:result.ticker,error:result.error})
    }
  }
  return {rows,failures}
}

module.exports=async function handler(req,res) {
  const auth=req.headers.authorization||''
  const allowed=auth===`Bearer ${process.env.CRON_SECRET||'__never__'}`||req.headers['x-vercel-cron']==='1'||req.query.secret===process.env.CRON_SECRET
  if(!allowed) return res.status(401).json({error:'Unauthorized'})
  const today=nyDate(),weekday=new Date(`${today}T12:00:00Z`).getUTCDay()
  if(weekday===0||weekday===6) return res.status(200).json({skipped:true,reason:'weekend'})
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY)
  const {data:scan,error}=await client.from('scan_results').select('ticker,score,trade_type,expires_at').gte('score',60).gt('expires_at',new Date().toISOString()).order('score',{ascending:false}).limit(60)
  if(error) return res.status(500).json({error:error.message})
  const candidates=[]
  for(const row of scan||[]) {
    if(!/call/i.test(row.trade_type||'')||candidates.some(item=>item.ticker===row.ticker)) continue
    candidates.push(row)
    if(candidates.length===10) break
  }
  if(!candidates.length) return res.status(200).json({captured:0,reason:'no bullish candidates'})
  try {
    const symbols=[...candidates.map(item=>item.ticker),'SPY','QQQ']
    const quoteData=await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbols.join(','))}&greeks=false`)
    const quotes=new Map(asArray(quoteData?.quotes?.quote).map(quote=>[quote.symbol,quote]))
    const spy=quotes.get('SPY'),qqq=quotes.get('QQQ'),spyPrice=Number(spy?.last||spy?.close),qqqChange=Number(qqq?.change_percentage),spyChange=Number(spy?.change_percentage)
    const regime=spyChange>0&&qqqChange>0?'RISK ON':spyChange<0&&qqqChange<0?'RISK OFF':'MIXED'
    const start=new Date(Date.now()-240*864e5).toISOString().slice(0,10),end=new Date().toISOString().slice(0,10)
    const {rows,failures}=await collectInBatches(candidates,async candidate=>{
        const quote=quotes.get(candidate.ticker),price=Number(quote?.last||quote?.close)
        if(!price) return null
        const [history,fund]=await Promise.all([
          tradier(`/markets/history?symbol=${candidate.ticker}&interval=daily&start=${start}&end=${end}`),
          withTimeout(getFundamentals(candidate.ticker),12000,`Fundamentals ${candidate.ticker}`).catch(()=>null),
        ])
        const bars=asArray(history?.history?.day)
        if(bars.length<30) throw new Error(`Insufficient price history (${bars.length} bars)`)
        const technical=analyzeStockBars(bars),health=analyzeFundamentalHealth(fund),healthPassed=['HEALTHY','ACCEPTABLE'].includes(health.status)
        const rating=health.status==='FUNDAMENTAL_RISK'?'AVOID':health.status==='EVENT_RISK'?'HOLD_WAIT':!healthPassed?'NOT_RATED':technical.status==='READY'?'BUY_SETUP':'HOLD_WAIT'
        const plan=healthPassed?buildPlan(price,technical):null
        const technicalScore=technical.technicalScore,edgeScore=technicalScore==null?null:Math.round((technicalScore+Number(candidate.score))/2)
        return {rating_date:today,ticker:candidate.ticker,algorithm_version:VERSION,rating,
          technical_state:technical.status==='READY'?'STRONG SETUP':technical.status==='WAIT'?'WEAK / WAIT':'NOT RATED',
          fundamental_state:health.status,setup:technical.setup||null,market_regime:regime,entry_price:price,benchmark_price:spyPrice||null,
          edge_score:edgeScore,technical_score:technicalScore,fundamental_score:health.score,
          entry_low:plan?.entryLow||null,entry_high:plan?.entryHigh||null,stop_price:plan?.stop||null,target_price:plan?.target||null,
          inputs:{healthCoverage:health.coverage,scannerScore:Number(candidate.score)},updated_at:new Date().toISOString()}
    })
    if(!rows.length) return res.status(502).json({error:'No stock ratings could be captured.',candidates:candidates.length,failures})
    const {error:writeError}=await client.from('stock_rating_history').upsert(rows,{onConflict:'rating_date,ticker,algorithm_version',ignoreDuplicates:true})
    if(writeError) return res.status(500).json({error:writeError.message})
    return res.status(200).json({captured:rows.length,candidates:candidates.length,failed:failures.length,failures,tradierCalls:1+candidates.length,version:VERSION})
  } catch(error) {
    console.error('[capture-stock-ratings]',error.message)
    return res.status(502).json({error:error.message})
  }
}

module.exports._test={withTimeout,collectInBatches}
