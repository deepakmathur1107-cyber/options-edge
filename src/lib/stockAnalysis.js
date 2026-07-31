const finite = value => Number.isFinite(Number(value))
const average = values => values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null

export function rsi14(closes) {
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

export function analyzeStockBars(inputBars) {
  const bars=(Array.isArray(inputBars)?inputBars:[])
    .map(bar=>({
      ...bar,close:Number(bar.close),high:Number(bar.high),low:Number(bar.low),volume:Number(bar.volume),
    }))
    .filter(bar=>finite(bar.close)&&finite(bar.high)&&finite(bar.low)&&bar.close>0)
  if (bars.length < 50) return { status:'INSUFFICIENT_DATA', reason:`Need 50 daily bars; received ${bars.length}.`, bars:bars.length }

  const closes=bars.map(bar=>bar.close)
  const latest=bars[bars.length-1]
  const prior20=bars.slice(-21,-1)
  const recent20=bars.slice(-20)
  const recent50=bars.slice(-50)
  const recent10=bars.slice(-10)
  const sma20=average(recent20.map(bar=>bar.close))
  const sma50=average(recent50.map(bar=>bar.close))
  const avgVolume20=average(recent20.map(bar=>bar.volume).filter(finite))
  const volumeRatio=avgVolume20>0?latest.volume/avgVolume20:null
  const support=Math.min(...recent10.map(bar=>bar.low))
  const resistance=Math.max(...prior20.map(bar=>bar.high))
  const rsi=rsi14(closes)
  const trendUp=sma20>sma50&&latest.close>sma50
  const distanceFromSma20=(latest.close/sma20)-1
  const nearSupport=latest.close>=support&&latest.close<=support*1.035
  const breakout=trendUp&&distanceFromSma20<=.07&&latest.close>=resistance*.995&&(volumeRatio==null||volumeRatio>=.9)
  const pullback=trendUp&&Math.abs(distanceFromSma20)<=.025&&rsi>=40&&rsi<=65
  const continuation=trendUp&&distanceFromSma20>0&&distanceFromSma20<=.055&&rsi>=50&&rsi<=72
  const supportBounce=trendUp&&nearSupport&&rsi>=38

  let setup='NO VALID SETUP', status='WAIT', reason='Price is not at a defined pullback, breakout, continuation, or support-bounce trigger.'
  if (breakout) {
    setup='BREAKOUT'; status='READY'; reason='Price is clearing 20-day resistance while the 20-day average remains above the 50-day average.'
  } else if (pullback) {
    setup='PULLBACK'; status='READY'; reason='Price has returned to the rising 20-day average with neutral momentum.'
  } else if (supportBounce) {
    setup='SUPPORT BOUNCE'; status='READY'; reason='Price is holding recent support inside an established uptrend.'
  } else if (continuation) {
    setup='TREND CONTINUATION'; status='READY'; reason='Price is advancing above rising 20-day and 50-day averages without being excessively extended.'
  } else if (!trendUp) {
    reason='Bullish alignment is absent: price and moving averages do not confirm an uptrend.'
  } else if (distanceFromSma20>.055) {
    reason='Uptrend is intact, but price is more than 5.5% above its 20-day average; wait for a lower-risk entry.'
  }

  const technicalScore=Math.round(Math.max(35,Math.min(95,
    50+(trendUp?18:-12)+(status==='READY'?12:0)+(volumeRatio>=1?5:0)+(rsi>=45&&rsi<=68?7:0)-(distanceFromSma20>.055?12:0)
  )))

  return {status,setup,reason,bars:bars.length,price:latest.close,rsi,support,resistance,sma20,sma50,volumeRatio,trendUp,distanceFromSma20,technicalScore}
}

export function buildStockTradePlan({price,analysis}) {
  if (!analysis||analysis.status==='INSUFFICIENT_DATA'||!finite(price)||Number(price)<=0) return null
  const p=Number(price)
  let low,high
  if (analysis.setup==='BREAKOUT') {
    low=Math.max(p,analysis.resistance)
    high=low*1.012
  } else if (analysis.setup==='PULLBACK') {
    low=Math.min(p,analysis.sma20)*.995
    high=Math.max(p,analysis.sma20)*1.01
  } else if (analysis.setup==='SUPPORT BOUNCE') {
    low=Math.max(analysis.support,p*.985)
    high=p*1.01
  } else {
    low=p*.99
    high=p*1.01
  }
  if (!finite(low)||!finite(high)||low<=0||high<low) return null
  const stop=Math.min(analysis.support*.985,analysis.sma50*.985)
  if (!finite(stop)||stop<=0||stop>=low) return null
  const risk=low-stop
  return {entryLow:Number(low.toFixed(2)),entryHigh:Number(high.toFixed(2)),stop:Number(stop.toFixed(2)),target1:Number((low+risk*1.5).toFixed(2)),target2:Number((low+risk*2.5).toFixed(2)),rr:'2.5×'}
}

export function isBullishScannerRow(row) {
  return /call/i.test(String(row?.trade_type||row?.option_type||''))
}

const metric = (fund, ...keys) => {
  for (const key of keys) {
    const raw=fund?.[key]
    if (raw===null||raw===undefined||raw==='') continue
    const value=Number(raw)
    if (Number.isFinite(value)) return value
  }
  return null
}

export function analyzeFundamentalHealth(fund, now=new Date()) {
  if (!fund) return {status:'DATA_INCOMPLETE',score:null,label:'DATA INCOMPLETE',reasons:['Fundamental data is unavailable.'],warnings:[],coverage:0}

  const sector=String(fund.sector||'')
  const specialized=/financial|bank|insurance|real estate|reit/i.test(sector)
  const marketCap=metric(fund,'market_cap','market_capitalization')
  const pe=metric(fund,'pe_ratio','pe_ttm')
  const profitMargin=metric(fund,'net_profit_margin_ttm')
  const revenueGrowth=metric(fund,'revenue_growth_ttm_yoy')
  const epsGrowth=metric(fund,'eps_growth_ttm_yoy')
  const debtToEquity=metric(fund,'debt_to_equity_annual')
  const currentRatio=metric(fund,'current_ratio_annual')
  const roe=metric(fund,'roe_ttm')
  const freeCashFlow=metric(fund,'free_cash_flow_ttm')
  const required=specialized?[marketCap,pe,profitMargin,revenueGrowth,roe]:[marketCap,pe,profitMargin,revenueGrowth,debtToEquity,currentRatio]
  const coverage=Math.round(required.filter(value=>value!=null).length/required.length*100)
  const reasons=[],warnings=[]
  let score=50

  if (marketCap!=null) marketCap>=2_000_000_000?(score+=8):(reasons.push('Market capitalization is below $2B.'),score-=18)
  if (pe!=null) {
    if (pe<=0) { reasons.push('Trailing earnings are not positive.'); score-=25 }
    else if (pe<=35) score+=8
    else if (pe<=50) warnings.push(`P/E ${pe.toFixed(1)} is elevated; compare with its sector.`)
    else { warnings.push(`P/E ${pe.toFixed(1)} indicates a large valuation premium.`); score-=10 }
  }
  if (profitMargin!=null) profitMargin>0?(score+=12):(reasons.push('Net profit margin is not positive.'),score-=25)
  if (revenueGrowth!=null) revenueGrowth>0?(score+=8):(reasons.push('Trailing revenue growth is not positive.'),score-=12)
  if (epsGrowth!=null) epsGrowth>=0?(score+=5):(warnings.push('Trailing EPS growth is negative.'),score-=8)
  if (roe!=null) roe>=10?(score+=6):warnings.push('Return on equity is below 10%.')
  if (!specialized&&debtToEquity!=null) debtToEquity<=2?(score+=6):(reasons.push(`Debt-to-equity ${debtToEquity.toFixed(2)} exceeds 2.0.`),score-=18)
  if (!specialized&&currentRatio!=null) currentRatio>=1?(score+=5):(reasons.push(`Current ratio ${currentRatio.toFixed(2)} is below 1.0.`),score-=12)
  if (freeCashFlow!=null) freeCashFlow>0?(score+=7):(reasons.push('Free cash flow is not positive.'),score-=15)

  const earningsDate=fund.earnings_date?new Date(`${String(fund.earnings_date).slice(0,10)}T12:00:00Z`):null
  const earningsDays=earningsDate&&Number.isFinite(earningsDate.getTime())?Math.ceil((earningsDate-now)/(864e5)):null
  if (earningsDays!=null&&earningsDays>=0&&earningsDays<=7) {
    return {status:'EVENT_RISK',score:Math.max(0,Math.min(100,Math.round(score))),label:'EVENT RISK',reasons:[`Earnings are scheduled in ${earningsDays} day${earningsDays===1?'':'s'}.`],warnings,coverage,metrics:{marketCap,pe,profitMargin,revenueGrowth,epsGrowth,debtToEquity,currentRatio,roe,freeCashFlow}}
  }
  score=Math.max(0,Math.min(100,Math.round(score)))
  if (coverage<75) return {status:'DATA_INCOMPLETE',score,label:'DATA INCOMPLETE',reasons:[`Only ${coverage}% of required health metrics are available.`],warnings,coverage,metrics:{marketCap,pe,profitMargin,revenueGrowth,epsGrowth,debtToEquity,currentRatio,roe,freeCashFlow}}
  if (reasons.length||score<65) return {status:'FUNDAMENTAL_RISK',score,label:'FUNDAMENTAL RISK',reasons:reasons.length?reasons:['Fundamental health score is below 65.'],warnings,coverage,metrics:{marketCap,pe,profitMargin,revenueGrowth,epsGrowth,debtToEquity,currentRatio,roe,freeCashFlow}}
  return {status:score>=80?'HEALTHY':'ACCEPTABLE',score,label:score>=80?'HEALTHY':'ACCEPTABLE',reasons:['Profitability, growth, balance-sheet and valuation checks passed.'],warnings,coverage,metrics:{marketCap,pe,profitMargin,revenueGrowth,epsGrowth,debtToEquity,currentRatio,roe,freeCashFlow}}
}
