import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeStockBars, buildStockTradePlan, isBullishScannerRow } from '../src/lib/stockAnalysis.js'

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

test('trade plans never return an inverted entry range',()=>{
  const analysis=analyzeStockBars(barsFor(Array.from({length:60},(_,i)=>100+i*.3)))
  const plan=buildStockTradePlan({price:118,analysis})
  assert.ok(plan)
  assert.ok(plan.entryHigh>=plan.entryLow)
  assert.ok(plan.stop<plan.entryLow)
})
