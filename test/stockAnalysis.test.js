import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { analyzeFundamentalHealth, analyzeStockBars, buildStockTradePlan, isBullishScannerRow, mergeLiveQuoteIntoDailyBars } from '../src/lib/stockAnalysis.js'

const require=createRequire(import.meta.url)
const serverRatingAnalysis=require('../api/_lib/stockRatingAnalysis.js')

const barsFor=(closes,{lastVolume=1000}={})=>closes.map((close,index)=>({date:`2026-01-${String(index+1).padStart(2,'0')}`,close,high:close*1.01,low:close*.99,volume:index===closes.length-1?lastVolume:1000}))

test('does not manufacture WAIT when history is missing',()=>{
  assert.equal(analyzeStockBars([]).status,'INSUFFICIENT_DATA')
})

test('classifies an orderly rising-trend continuation as ready',()=>{
  const closes=Array.from({length:60},(_,i)=>100+i*.3+Math.sin(i)*1.2)
  const result=analyzeStockBars(barsFor(closes))
  assert.equal(result.status,'READY')
  assert.match(result.setup,/BREAKOUT|TREND CONTINUATION/)
})

test('keeps a materially extended stock on wait',()=>{
  const closes=[...Array.from({length:59},(_,i)=>100+i*.1),125]
  const result=analyzeStockBars(barsFor(closes))
  assert.equal(result.status,'WAIT')
  assert.match(result.reason,/5\.5%|defined/)
})

test('fresh live resistance cross can create a provisional buy setup',()=>{
  const now=new Date('2026-08-13T15:00:00Z')
  const closes=[...Array.from({length:30},(_,i)=>78-i*.18),...Array.from({length:20},(_,i)=>72+i*.08)]
  const historical=barsFor(closes)
  const merged=mergeLiveQuoteIntoDailyBars(historical,{last:75.2,high:75.3,low:74.8,volume:1300,trade_date:now.getTime()/1000},now)
  const result=analyzeStockBars(merged.bars)
  assert.equal(merged.provisional,true)
  assert.equal(result.status,'READY')
  assert.equal(result.setup,'BREAKOUT')
  assert.equal(result.provisional,true)
})

test('stale live quotes never change the confirmed daily rating',()=>{
  const now=new Date('2026-08-13T15:00:00Z')
  const historical=barsFor(Array.from({length:60},(_,i)=>100+i*.1))
  const merged=mergeLiveQuoteIntoDailyBars(historical,{last:200,high:201,low:199,volume:5000,trade_date:(now.getTime()-10*60*1000)/1000},now)
  assert.equal(merged.provisional,false)
  assert.equal(merged.bars.length,historical.length)
})

test('live breakout does not chase beyond two percent over resistance',()=>{
  const now=new Date('2026-08-13T15:00:00Z')
  const closes=[...Array.from({length:30},(_,i)=>78-i*.18),...Array.from({length:20},(_,i)=>72+i*.08)]
  const historical=barsFor(closes)
  const resistance=Math.max(...historical.slice(-20).map(bar=>bar.high))
  const price=resistance*1.025
  const merged=mergeLiveQuoteIntoDailyBars(historical,{last:price,high:price,low:price*.995,volume:1400,trade_date:now.getTime()/1000},now)
  assert.equal(analyzeStockBars(merged.bars).status,'WAIT')
})

test('rejects bearish option scanner rows from bullish stock discovery',()=>{
  assert.equal(isBullishScannerRow({trade_type:'Long Put'}),false)
  assert.equal(isBullishScannerRow({trade_type:'Long Call'}),true)
})

test('fundamental health gate fails closed when critical data is missing',()=>{
  const result=analyzeFundamentalHealth({sector:'Technology',market_cap:10_000_000_000})
  assert.equal(result.status,'DATA_INCOMPLETE')
})

test('fundamental health gate accepts a profitable growing business',()=>{
  const result=analyzeFundamentalHealth({
    sector:'Technology',market_cap:100_000_000_000,pe_ratio:24,
    net_profit_margin_ttm:18,revenue_growth_ttm_yoy:12,eps_growth_ttm_yoy:10,
    debt_to_equity_annual:.4,current_ratio_annual:1.8,roe_ttm:22,free_cash_flow_ttm:5,
  })
  assert.equal(result.status,'HEALTHY')
})

test('fundamental health gate blocks near-term earnings',()=>{
  const now=new Date('2026-07-31T12:00:00Z')
  const result=analyzeFundamentalHealth({
    sector:'Technology',market_cap:100_000_000_000,pe_ratio:24,
    net_profit_margin_ttm:18,revenue_growth_ttm_yoy:12,
    debt_to_equity_annual:.4,current_ratio_annual:1.8,earnings_date:'2026-08-04',
  },now)
  assert.equal(result.status,'EVENT_RISK')
})

test('server stock-rating capture matches client technical and health decisions',()=>{
  const bars=Array.from({length:80},(_,index)=>({close:100+index*.45,high:101+index*.45,low:99+index*.45,volume:1_000_000}))
  const fund={sector:'Technology',market_cap:100_000_000_000,pe_ratio:24,net_profit_margin_ttm:18,revenue_growth_ttm_yoy:12,eps_growth_ttm_yoy:10,debt_to_equity_annual:.4,current_ratio_annual:1.8,roe_ttm:22,free_cash_flow_ttm:5}
  assert.equal(serverRatingAnalysis.analyzeStockBars(bars).status,analyzeStockBars(bars).status)
  assert.equal(serverRatingAnalysis.analyzeFundamentalHealth(fund).status,analyzeFundamentalHealth(fund).status)
})

test('trade plans never return an inverted entry range',()=>{
  const analysis=analyzeStockBars(barsFor(Array.from({length:60},(_,i)=>100+i*.3)))
  const plan=buildStockTradePlan({price:118,analysis})
  assert.ok(plan)
  assert.ok(plan.entryHigh>=plan.entryLow)
  assert.ok(plan.stop<plan.entryLow)
})
