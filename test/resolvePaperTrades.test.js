const test=require('node:test')
const assert=require('node:assert/strict')
const resolver=require('../api/cron/resolve-trade-outcomes')._test

test('paper-trade resolver separates stocks from option contracts',()=>{
  assert.equal(resolver.isStockTrade({option_type:'stock'}),true)
  assert.equal(resolver.isStockTrade({option_type:'call'}),false)
  assert.equal(resolver.isStockTrade({type:'Put'}),false)
})

test('stock daily bars use conservative same-bar resolution',()=>{
  assert.deepEqual(
    resolver.findFirstThresholdHit([{high:111,low:94,time:'2026-08-13'}],110,95),
    {type:'same_bar_tiebreak',outcome:'LOSS',at:'2026-08-13'}
  )
})
