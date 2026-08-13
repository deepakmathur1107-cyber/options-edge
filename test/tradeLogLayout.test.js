const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')

test('trade log header and rows share one alignment grid',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/pages/TradeLog.jsx'),'utf8')
  assert.match(source,/const tradeGrid=/)
  assert.equal((source.match(/gridTemplateColumns:tradeGrid/g)||[]).length,2)
  assert.match(source,/\['Symbol','Type','Side','Strike','Exp','Qty','Entry','Current','Exit','P&L','Actions'\]/)
})

test('stock trade rows expose current price and unrealized pnl',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/pages/TradeLog.jsx'),'utf8')
  assert.match(source,/current_price/)
  assert.match(source,/calcUnrealizedPnl/)
  assert.match(source,/NO EXPIRY/)
})
