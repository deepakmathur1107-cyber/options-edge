const { createClient } = require('@supabase/supabase-js')

const TRADIER_MODE=process.env.TRADIER_MODE||'production'
const TRADIER_BASE=TRADIER_MODE==='sandbox'?'https://sandbox.tradier.com/v1':'https://api.tradier.com/v1'
const TRADIER_TOKEN=process.env.TRADIER_TOKEN||''
const MAX_ROWS=5000

const asArray=value=>!value?[]:Array.isArray(value)?value:[value]
const nyDate=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)
const pct=(current,entry)=>Number((((current/entry)-1)*100).toFixed(4))
function evaluateDailyBar(quote,row) {
  const close=Number(quote?.last||quote?.close)
  const high=Number(quote?.high||close),low=Number(quote?.low||close)
  const target=row?.target_price==null?null:Number(row.target_price)
  const stop=row?.stop_price==null?null:Number(row.stop_price)
  const hitTarget=target!=null&&Number.isFinite(target)&&high>=target
  const hitStop=stop!=null&&Number.isFinite(stop)&&low<=stop
  return {close,high,low,outcome:hitStop?'STOP':hitTarget?'TARGET':null}
}

async function fetchQuotes(symbols) {
  const result=new Map()
  for(let index=0;index<symbols.length;index+=50) {
    const chunk=symbols.slice(index,index+50)
    const response=await fetch(`${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(chunk.join(','))}&greeks=false`,{
      headers:{Authorization:`Bearer ${TRADIER_TOKEN}`,Accept:'application/json'},
    })
    if(!response.ok) throw new Error(`Tradier quotes failed (${response.status})`)
    const json=await response.json()
    for(const quote of asArray(json?.quotes?.quote)) if(quote?.symbol) result.set(quote.symbol,quote)
  }
  return result
}

function quoteDate(quote) {
  const raw=quote?.trade_date??quote?.trade_time
  if(raw==null) return null
  const numeric=Number(raw)
  const date=Number.isFinite(numeric)?new Date(numeric>1e12?numeric:numeric*1000):new Date(raw)
  return Number.isFinite(date.getTime())?nyDate(date):null
}

module.exports=async function handler(req,res) {
  const auth=req.headers.authorization||''
  const allowed=auth===`Bearer ${process.env.CRON_SECRET||'__never__'}`||req.headers['x-vercel-cron']==='1'||req.query.secret===process.env.CRON_SECRET
  if(!allowed) return res.status(401).json({error:'Unauthorized'})
  const today=nyDate(new Date())
  const weekday=new Date(`${today}T12:00:00Z`).getUTCDay()
  if(weekday===0||weekday===6) return res.status(200).json({skipped:true,reason:'weekend'})
  if(!TRADIER_TOKEN) return res.status(500).json({error:'Tradier not configured'})

  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY)
  const {data,error}=await client.from('stock_rating_history').select('*')
    .eq('rating','BUY_SETUP').is('close_outcome',null).lt('rating_date',today)
    .order('rating_date',{ascending:true}).limit(MAX_ROWS)
  if(error) return res.status(500).json({error:error.message})
  const rows=(data||[]).filter(row=>row.last_observed_date!==today)
  if(!rows.length) return res.status(200).json({processed:0,reason:'nothing due'})

  try {
    const symbols=[...new Set([...rows.map(row=>row.ticker),'SPY'])]
    const quotes=await fetchQuotes(symbols)
    const spy=quotes.get('SPY'),spyPrice=Number(spy?.last||spy?.close)
    if(!spyPrice||quoteDate(spy)!==today) return res.status(200).json({skipped:true,reason:'no confirmed market session'})
    const updates=[]
    for(const row of rows) {
      const quote=quotes.get(row.ticker),bar=evaluateDailyBar(quote,row),price=bar.close
      if(!price||quoteDate(quote)!==today) continue
      const sessions=Number(row.sessions_observed||0)+1
      const stockReturn=pct(price,Number(row.entry_price))
      const highReturn=pct(bar.high,Number(row.entry_price)),lowReturn=pct(bar.low,Number(row.entry_price))
      const spyReturn=row.benchmark_price?pct(spyPrice,Number(row.benchmark_price)):null
      const next={...row,sessions_observed:sessions,last_observed_date:today,latest_price:price,latest_benchmark_price:spyPrice,
        max_return:row.max_return==null?highReturn:Math.max(Number(row.max_return),highReturn),
        max_drawdown:row.max_drawdown==null?lowReturn:Math.min(Number(row.max_drawdown),lowReturn),updated_at:new Date().toISOString()}
      for(const horizon of [5,10,20,60]) if(sessions===horizon) {
        next[`return_${horizon}d`]=stockReturn
        next[`spy_return_${horizon}d`]=spyReturn
      }
      if(bar.outcome) {
        next.close_outcome=bar.outcome; next.close_outcome_at=new Date().toISOString()
      }
      updates.push(next)
    }
    if(updates.length) {
      const {error:updateError}=await client.from('stock_rating_history').upsert(updates,{onConflict:'id'})
      if(updateError) return res.status(500).json({error:updateError.message})
    }
    return res.status(200).json({processed:updates.length,quotesRequested:symbols.length,apiCalls:Math.ceil(symbols.length/50),remainingMayExist:(data||[]).length===MAX_ROWS})
  } catch(e) {
    console.error('[resolve-stock-ratings]',e.message)
    return res.status(502).json({error:e.message})
  }
}

module.exports._test={evaluateDailyBar}
