const finite=value=>Number.isFinite(Number(value))
const average=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null
const metric=(fund,...keys)=>{
  for(const key of keys) {
    const raw=fund?.[key]
    if(raw===null||raw===undefined||raw==='') continue
    if(finite(raw)) return Number(raw)
  }
  return null
}
function rsi14(closes) {
  if(closes.length<15) return null
  let gains=0,losses=0
  for(let index=closes.length-14;index<closes.length;index++) {
    const move=closes[index]-closes[index-1]
    move>=0?gains+=move:losses-=move
  }
  return losses?Math.round(100-(100/(1+(gains/14)/(losses/14)))):100
}
function analyzeStockBars(input) {
  const bars=(Array.isArray(input)?input:[]).map(bar=>({...bar,close:Number(bar.close),high:Number(bar.high),low:Number(bar.low),volume:Number(bar.volume)})).filter(bar=>finite(bar.close)&&finite(bar.high)&&finite(bar.low)&&bar.close>0)
  if(bars.length<50) return {status:'INSUFFICIENT_DATA',technicalScore:null}
  const latest=bars.at(-1),recent20=bars.slice(-20),recent50=bars.slice(-50),recent10=bars.slice(-10),prior20=bars.slice(-21,-1)
  const sma20=average(recent20.map(bar=>bar.close)),sma50=average(recent50.map(bar=>bar.close)),rsi=rsi14(bars.map(bar=>bar.close))
  const avgVolume=average(recent20.map(bar=>bar.volume).filter(finite)),volumeRatio=avgVolume>0?latest.volume/avgVolume:null
  const support=Math.min(...recent10.map(bar=>bar.low)),resistance=Math.max(...prior20.map(bar=>bar.high))
  const trendUp=sma20>sma50&&latest.close>sma50,distance=(latest.close/sma20)-1,nearSupport=latest.close>=support&&latest.close<=support*1.035
  // A price-only breakout produced the weakest forward cohort. Require real
  // participation and avoid chasing names already stretched from the 20-day.
  const breakout=trendUp&&distance<=.05&&latest.close>=resistance*.995&&volumeRatio>=1.15
  const pullback=trendUp&&Math.abs(distance)<=.025&&rsi>=40&&rsi<=65
  const continuation=trendUp&&distance>0&&distance<=.055&&rsi>=50&&rsi<=72
  const supportBounce=trendUp&&nearSupport&&rsi>=38
  const setup=breakout?'BREAKOUT':pullback?'PULLBACK':supportBounce?'SUPPORT BOUNCE':continuation?'TREND CONTINUATION':'NO VALID SETUP'
  const status=setup==='NO VALID SETUP'?'WAIT':'READY'
  const technicalScore=Math.round(Math.max(35,Math.min(95,50+(trendUp?18:-12)+(status==='READY'?12:0)+(volumeRatio>=1?5:0)+(rsi>=45&&rsi<=68?7:0)-(distance>.055?12:0))))
  return {status,setup,technicalScore,support,resistance,sma20,sma50}
}
function analyzeFundamentalHealth(fund,now=new Date()) {
  if(!fund) return {status:'DATA_INCOMPLETE',score:null,coverage:0}
  const specialized=/financial|bank|insurance|real estate|reit/i.test(String(fund.sector||''))
  const marketCap=metric(fund,'market_cap'),pe=metric(fund,'pe_ratio'),profit=metric(fund,'net_profit_margin_ttm'),growth=metric(fund,'revenue_growth_ttm_yoy')
  const eps=metric(fund,'eps_growth_ttm_yoy'),debt=metric(fund,'debt_to_equity_annual'),current=metric(fund,'current_ratio_annual'),roe=metric(fund,'roe_ttm'),fcf=metric(fund,'free_cash_flow_ttm')
  const required=specialized?[marketCap,pe,profit,growth,roe]:[marketCap,pe,profit,growth,debt,current]
  const coverage=Math.round(required.filter(value=>value!=null).length/required.length*100)
  let score=50,risk=false
  if(marketCap!=null) marketCap>=2e9?score+=8:(score-=18,risk=true)
  if(pe!=null) pe<=0?(score-=25,risk=true):pe<=35?score+=8:pe>50&&(score-=10)
  if(profit!=null) profit>0?score+=12:(score-=25,risk=true)
  if(growth!=null) growth>0?score+=8:(score-=12,risk=true)
  if(eps!=null) eps>=0?score+=5:score-=8
  if(roe!=null&&roe>=10) score+=6
  if(!specialized&&debt!=null) debt<=2?score+=6:(score-=18,risk=true)
  if(!specialized&&current!=null) current>=1?score+=5:(score-=12,risk=true)
  if(fcf!=null) fcf>0?score+=7:(score-=15,risk=true)
  score=Math.max(0,Math.min(100,Math.round(score)))
  const earnings=fund.earnings_date?new Date(`${String(fund.earnings_date).slice(0,10)}T12:00:00Z`):null
  const days=earnings&&finite(earnings.getTime())?Math.ceil((earnings-now)/864e5):null
  if(days!=null&&days>=0&&days<=7) return {status:'EVENT_RISK',score,coverage}
  if(coverage<75) return {status:'DATA_INCOMPLETE',score,coverage}
  if(risk||score<65) return {status:'FUNDAMENTAL_RISK',score,coverage}
  return {status:score>=80?'HEALTHY':'ACCEPTABLE',score,coverage}
}
function buildPlan(price,analysis) {
  if(analysis?.status!=='READY'||!finite(price)) return null
  const p=Number(price),low=analysis.setup==='BREAKOUT'?Math.max(p,analysis.resistance):analysis.setup==='PULLBACK'?Math.min(p,analysis.sma20)*.995:analysis.setup==='SUPPORT BOUNCE'?Math.max(analysis.support,p*.985):p*.99
  const high=analysis.setup==='BREAKOUT'?low*1.012:analysis.setup==='PULLBACK'?Math.max(p,analysis.sma20)*1.01:p*1.01
  const stop=Math.min(analysis.support*.985,analysis.sma50*.985)
  if(!finite(low)||!finite(high)||!finite(stop)||stop>=low) return null
  const risk=low-stop
  return {entryLow:low,entryHigh:high,stop,target:low+risk*2.5}
}
module.exports={analyzeStockBars,analyzeFundamentalHealth,buildPlan}
