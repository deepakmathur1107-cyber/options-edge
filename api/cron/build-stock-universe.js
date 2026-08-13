const {createClient}=require('@supabase/supabase-js')
const {SP500}=require('../_lib/sp500')
const {getFundamentals}=require('../_lib/fundamentals')
const {analyzeStockBars,analyzeFundamentalHealth,buildPlan}=require('../_lib/stockRatingAnalysis')

const VERSION='stock-universe-v1'
const BATCH_SIZE=12
const MIN_PRICE=10
const MIN_AVERAGE_VOLUME=1000000
const MIN_MARKET_CAP=5000000000
const MIN_FUNDAMENTAL_SCORE=70
const MIN_FUNDAMENTAL_COVERAGE=80
const ADRS=['PDD','BABA','JD','BIDU','NTES','TCOM','MELI','SE','NU']
const UNIVERSE=[...new Set([...SP500,...ADRS])].filter(symbol=>/^[A-Z][A-Z.-]{0,5}$/.test(symbol))
const BASE=(process.env.TRADIER_MODE||'production')==='sandbox'?'https://sandbox.tradier.com/v1':'https://api.tradier.com/v1'
const HEADERS={Authorization:`Bearer ${process.env.TRADIER_TOKEN||''}`,Accept:'application/json'}
const asArray=value=>!value?[]:Array.isArray(value)?value:[value]
const nyDate=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)
// The batch window crosses midnight ET. Shift the operational date so every
// batch from the same post-close run shares one cursor/checkpoint record.
const nightlyRunDate=()=>nyDate(new Date(Date.now()-6*60*60*1000))
const timeout=(promise,ms,label)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} timed out`)),ms))])
async function tradier(path) {
  const response=await timeout(fetch(`${BASE}${path}`,{headers:HEADERS}),20000,'Market data')
  if(!response.ok) throw new Error(`Tradier ${response.status}`)
  return response.json()
}
async function batches(items,worker,size=3) {
  const output=[]
  for(let i=0;i<items.length;i+=size) output.push(...await Promise.all(items.slice(i,i+size).map(worker)))
  return output
}
function exclusion({price,averageVolume,marketCap,health}) {
  if(!Number.isFinite(price)||price<MIN_PRICE) return `Price below $${MIN_PRICE} quality floor`
  if(!Number.isFinite(averageVolume)||averageVolume<MIN_AVERAGE_VOLUME) return 'Insufficient average daily volume'
  if(!Number.isFinite(Number(marketCap))||Number(marketCap)<MIN_MARKET_CAP) return 'Market capitalization below $5B quality floor'
  if(health.coverage<MIN_FUNDAMENTAL_COVERAGE) return 'Fundamental coverage below 80%'
  if(!['HEALTHY','ACCEPTABLE'].includes(health.status)||health.score<MIN_FUNDAMENTAL_SCORE) return 'Fundamental quality below medium'
  return null
}
function toRatingHistory(row,benchmarkPrice=null) {
  if(!row?.eligible||row.rating!=='BUY_SETUP') return null
  return {
    rating_date:row.snapshot_date,ticker:row.ticker,algorithm_version:row.algorithm_version,
    rating:row.rating,technical_state:row.technical_state,fundamental_state:row.fundamental_state,
    setup:row.setup||null,market_regime:'NIGHTLY CLOSE',entry_price:row.price,
    benchmark_price:Number(benchmarkPrice)||null,edge_score:row.edge_score,
    technical_score:row.technical_score,fundamental_score:row.fundamental_score,
    entry_low:row.entry_low,entry_high:row.entry_high,stop_price:row.stop_price,
    target_price:row.target_price,
    inputs:{source:'stock_universe_snapshots',fundamentalCoverage:row.fundamental_coverage},
    updated_at:new Date().toISOString(),
  }
}

module.exports=async function handler(req,res) {
  const auth=req.headers.authorization||''
  const allowed=auth===`Bearer ${process.env.CRON_SECRET||'__never__'}`||req.headers['x-vercel-cron']==='1'||req.query.secret===process.env.CRON_SECRET
  if(!allowed) return res.status(401).json({error:'Unauthorized'})
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY)
  const runDate=nightlyRunDate()
  const {data:existing,error:runError}=await client.from('stock_universe_runs').select('*').eq('run_date',runDate).maybeSingle()
  if(runError) return res.status(500).json({error:runError.message})
  if(existing?.status==='COMPLETE') return res.status(200).json({complete:true,runDate,processed:existing.processed_count,eligible:existing.eligible_count})
  const cursor=Math.min(Number(existing?.cursor_position||0),UNIVERSE.length)
  const symbols=UNIVERSE.slice(cursor,cursor+BATCH_SIZE)
  if(!symbols.length) return res.status(200).json({complete:true,runDate,processed:existing?.processed_count||0})
  const start=new Date(Date.now()-260*864e5).toISOString().slice(0,10),end=new Date().toISOString().slice(0,10)
  const errors=[]
  try {
    const quoteSymbols=[...new Set([...symbols,'SPY'])]
    const quoteData=await tradier(`/markets/quotes?symbols=${encodeURIComponent(quoteSymbols.join(','))}&greeks=false`)
    const quotes=new Map(asArray(quoteData?.quotes?.quote).map(q=>[q.symbol,q]))
    const results=await batches(symbols,async ticker=>{
      try {
        const [history,fund]=await Promise.all([
          tradier(`/markets/history?symbol=${ticker}&interval=daily&start=${start}&end=${end}`),
          timeout(getFundamentals(ticker),15000,`Fundamentals ${ticker}`).catch(()=>null),
        ])
        const bars=asArray(history?.history?.day),quote=quotes.get(ticker)||{}
        if(bars.length<50) throw new Error(`Only ${bars.length} daily bars`)
        const technical=analyzeStockBars(bars),health=analyzeFundamentalHealth(fund)
        const latest=bars.at(-1),price=Number(quote.last||quote.close||latest.close)
        const recentVolumes=bars.slice(-20).map(bar=>Number(bar.volume)).filter(Number.isFinite)
        const averageVolume=recentVolumes.length?Math.round(recentVolumes.reduce((a,b)=>a+b,0)/recentVolumes.length):0
        const blocked=exclusion({price,averageVolume,marketCap:fund?.market_cap,health}),eligible=!blocked
        const plan=eligible?buildPlan(price,technical):null
        const edge=eligible&&technical.technicalScore!=null?Math.round(technical.technicalScore*.55+health.score*.45):null
        const snapshotDate=String(latest.date||runDate).slice(0,10)
        return {snapshot_date:snapshotDate,ticker,algorithm_version:VERSION,company_name:quote.description||fund?.name||ticker,sector:fund?.sector||null,industry:fund?.industry||fund?.sub_industry||null,
          price,average_volume:averageVolume,market_cap:fund?.market_cap||null,pe_ratio:fund?.pe_ratio||null,earnings_date:fund?.earnings_date||null,
          fundamental_state:health.status,fundamental_score:health.score,fundamental_coverage:health.coverage,technical_state:technical.status,technical_score:technical.technicalScore,
          edge_score:edge,rating:!eligible?'EXCLUDED':technical.status==='READY'?'BUY_SETUP':'HOLD_WAIT',setup:technical.setup||null,rsi:null,
          volume_ratio:latest.volume&&averageVolume?Number(latest.volume)/averageVolume:null,sma_20:technical.sma20||null,sma_50:technical.sma50||null,support:technical.support||null,resistance:technical.resistance||null,
          entry_low:plan?.entryLow||null,entry_high:plan?.entryHigh||null,stop_price:plan?.stop||null,target_price:plan?.target||null,eligible,exclusion_reason:blocked,
          analysis_reason:blocked||technical.setup||technical.status,updated_at:new Date().toISOString()}
      } catch(error) { errors.push({ticker,error:error.message||String(error)}); return null }
    })
    const rows=results.filter(Boolean)
    if(rows.length) {
      const {error}=await client.from('stock_universe_snapshots').upsert(rows,{onConflict:'snapshot_date,ticker,algorithm_version'})
      if(error) throw error
      const spy=quotes.get('SPY'),benchmarkPrice=Number(spy?.last||spy?.close)||null
      const candidates=rows.map(row=>toRatingHistory(row,benchmarkPrice)).filter(Boolean)
      let ratings=candidates
      if(candidates.length) {
        const cutoff=new Date(Date.now()-10*864e5).toISOString().slice(0,10)
        const {data:recent,error:recentError}=await client.from('stock_rating_history')
          .select('ticker,rating_date').in('ticker',candidates.map(row=>row.ticker)).gte('rating_date',cutoff)
        if(recentError) throw recentError
        const blockedTickers=new Set((recent||[]).map(row=>row.ticker))
        ratings=candidates.filter(row=>!blockedTickers.has(row.ticker))
      }
      if(ratings.length) {
        const {error:ratingError}=await client.from('stock_rating_history').upsert(ratings,{onConflict:'rating_date,ticker,algorithm_version',ignoreDuplicates:true})
        if(ratingError) throw ratingError
      }
    }
    const nextCursor=cursor+symbols.length,complete=nextCursor>=UNIVERSE.length
    const run={run_date:runDate,algorithm_version:VERSION,cursor_position:nextCursor,universe_size:UNIVERSE.length,
      processed_count:Number(existing?.processed_count||0)+rows.length,eligible_count:Number(existing?.eligible_count||0)+rows.filter(row=>row.eligible).length,
      failed_count:Number(existing?.failed_count||0)+errors.length,status:complete?'COMPLETE':'RUNNING',last_errors:errors.slice(-12),completed_at:complete?new Date().toISOString():null,updated_at:new Date().toISOString()}
    const {error:updateError}=await client.from('stock_universe_runs').upsert(run,{onConflict:'run_date'})
    if(updateError) throw updateError
    return res.status(200).json({runDate,batch:{from:cursor,to:nextCursor},universe:UNIVERSE.length,stored:rows.length,eligible:rows.filter(row=>row.eligible).length,failed:errors.length,complete})
  } catch(error) {
    console.error('[build-stock-universe]',error.message)
    return res.status(502).json({error:error.message,cursor,errors})
  }
}

module.exports._test={exclusion,toRatingHistory,nightlyRunDate,UNIVERSE,MIN_PRICE,MIN_AVERAGE_VOLUME,MIN_MARKET_CAP,MIN_FUNDAMENTAL_SCORE,MIN_FUNDAMENTAL_COVERAGE}
