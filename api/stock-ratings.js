const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('./_lib/auth')
const { rateLimit } = require('./_lib/rateLimit')

const VERSION='stock-health-v1'
const RATINGS=new Set(['BUY_SETUP','HOLD_WAIT','AVOID','NOT_RATED'])
const num=value=>{
  if(value===null||value===undefined||value==='') return null
  const parsed=Number(value)
  return Number.isFinite(parsed)?parsed:null
}
const nyDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())

async function hasActiveSub(clerkId,client) {
  if(ADMIN_IDS.includes(clerkId)) return true
  const {data}=await client.from('subscriptions').select('status').eq('clerk_id',clerkId).maybeSingle()
  return data?.status==='active'||data?.status==='trialing'
}

function summarize(rows,horizon) {
  const field=`return_${horizon}d`,spyField=`spy_return_${horizon}d`
  const measured=rows.filter(row=>num(row[field])!=null)
  if(!measured.length) return {sampleSize:0,winRate:null,averageReturn:null,averageVsSpy:null}
  const average=values=>values.reduce((sum,value)=>sum+value,0)/values.length
  const compared=measured.filter(row=>num(row[spyField])!=null)
  return {
    sampleSize:measured.length,
    winRate:Number((measured.filter(row=>Number(row[field])>0).length/measured.length*100).toFixed(1)),
    averageReturn:Number(average(measured.map(row=>Number(row[field]))).toFixed(2)),
    averageVsSpy:compared.length?Number(average(compared.map(row=>Number(row[field])-Number(row[spyField]))).toFixed(2)):null,
  }
}

module.exports=async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type')
  if(req.method==='OPTIONS') return res.status(204).end()
  const {clerkId,error:authError}=await getAuth(req)
  if(!clerkId) return res.status(401).json({error:authError||'Unauthorized'})
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY)
  if(!(await hasActiveSub(clerkId,client))) return res.status(402).json({error:'An active subscription is required.'})

  if(req.method==='POST') {
    if(!ADMIN_IDS.includes(clerkId)) return res.status(403).json({error:'Automated server capture only.'})
    const {allowed}=await rateLimit(`stock-ratings:${clerkId}`,12,60)
    if(!allowed) return res.status(429).json({error:'Rating snapshot limit reached.'})
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{})
    const snapshots=Array.isArray(body.snapshots)?body.snapshots.slice(0,10):[]
    const ratingDate=nyDate()
    const rows=snapshots.map(item=>({
      rating_date:ratingDate,
      ticker:String(item.ticker||'').toUpperCase(),
      algorithm_version:VERSION,
      rating:RATINGS.has(item.rating)?item.rating:'NOT_RATED',
      technical_state:String(item.technicalState||'NOT_RATED').slice(0,40),
      fundamental_state:String(item.fundamentalState||'NOT_RATED').slice(0,40),
      setup:String(item.setup||'').slice(0,80)||null,
      market_regime:String(item.marketRegime||'UNAVAILABLE').slice(0,30),
      entry_price:num(item.entryPrice),benchmark_price:num(item.benchmarkPrice),
      edge_score:num(item.edgeScore),technical_score:num(item.technicalScore),fundamental_score:num(item.fundamentalScore),
      entry_low:num(item.entryLow),entry_high:num(item.entryHigh),stop_price:num(item.stopPrice),target_price:num(item.targetPrice),
      inputs:{healthCoverage:num(item.healthCoverage),scannerScore:num(item.scannerScore)},
    })).filter(row=>/^[A-Z][A-Z.-]{0,5}$/.test(row.ticker)&&row.entry_price>0)
    if(!rows.length) return res.status(400).json({error:'No valid rating snapshots supplied.'})
    const {error}=await client.from('stock_rating_history').upsert(rows,{onConflict:'rating_date,ticker,algorithm_version',ignoreDuplicates:true})
    if(error) return res.status(500).json({error:error.message})
    return res.status(200).json({captured:rows.length,ratingDate,version:VERSION})
  }

  if(req.method==='GET') {
    const since=new Date(Date.now()-400*864e5).toISOString().slice(0,10)
    const {data,error}=await client.from('stock_rating_history')
      .select('rating_date,ticker,rating,technical_state,fundamental_state,setup,entry_price,edge_score,return_5d,return_10d,return_20d,return_60d,spy_return_5d,spy_return_10d,spy_return_20d,spy_return_60d,close_outcome,sessions_observed')
      .gte('rating_date',since).order('rating_date',{ascending:false}).limit(5000)
    if(error) return res.status(500).json({error:error.message})
    const rows=data||[],buyRows=rows.filter(row=>row.rating==='BUY_SETUP')
    return res.status(200).json({
      methodology:'Forward-observed daily closing prices; one immutable rating per ticker/day/version. Results exclude fees and are not investment advice.',
      version:VERSION,totalRatings:rows.length,buySetups:buyRows.length,
      horizons:{5:summarize(buyRows,5),10:summarize(buyRows,10),20:summarize(buyRows,20),60:summarize(buyRows,60)},
      recent:rows.slice(0,20),
    })
  }
  return res.status(405).json({error:'Method not allowed'})
}
