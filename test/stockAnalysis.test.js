import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeFundamentalHealth, analyzeStockBars, buildStockTradePlan, isBullishScannerRow } from '../src/lib/stockAnalysis.js'

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

test('trade plans never return an inverted entry range',()=>{
  const analysis=analyzeStockBars(barsFor(Array.from({length:60},(_,i)=>100+i*.3)))
  const plan=buildStockTradePlan({price:118,analysis})
  assert.ok(plan)
  assert.ok(plan.entryHigh>=plan.entryLow)
  assert.ok(plan.stop<plan.entryLow)
})
