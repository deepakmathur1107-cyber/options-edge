const test=require('node:test')
const assert=require('node:assert/strict')
const {exclusion,toRatingHistory,UNIVERSE,MIN_PRICE,MIN_AVERAGE_VOLUME,MIN_MARKET_CAP}=require('../api/cron/build-stock-universe')._test

const healthy={status:'ACCEPTABLE',score:70,coverage:80}
const quality={averageVolume:MIN_AVERAGE_VOLUME,marketCap:MIN_MARKET_CAP,health:healthy}

test('nightly universe excludes penny stocks',()=>{
  assert.match(exclusion({price:MIN_PRICE-.01,...quality}),/quality floor/)
})

test('nightly universe excludes low-liquidity stocks',()=>{
  assert.match(exclusion({price:20,...quality,averageVolume:MIN_AVERAGE_VOLUME-1}),/volume/)
})

test('nightly universe requires medium-to-high fundamentals',()=>{
  assert.match(exclusion({price:20,...quality,health:{status:'FUNDAMENTAL_RISK',score:64,coverage:100}}),/quality/)
  assert.match(exclusion({price:20,...quality,health:{status:'HEALTHY',score:90,coverage:60}}),/coverage/)
  assert.equal(exclusion({price:20,...quality}),null)
})

test('nightly universe is broader than the former ten-stock list and includes PDD',()=>{
  assert.ok(UNIVERSE.length>300)
  assert.ok(UNIVERSE.includes('PDD'))
})

test('eligible nightly snapshots enroll as immutable forward ratings',()=>{
  const rating=toRatingHistory({snapshot_date:'2026-08-12',ticker:'MSFT',algorithm_version:'stock-universe-v1',eligible:true,rating:'BUY_SETUP',price:500,technical_state:'READY',fundamental_state:'HEALTHY',fundamental_coverage:100,edge_score:88,technical_score:80,fundamental_score:98},700)
  assert.equal(rating.rating_date,'2026-08-12')
  assert.equal(rating.entry_price,500)
  assert.equal(rating.benchmark_price,700)
  assert.equal(rating.inputs.source,'stock_universe_snapshots')
})

test('excluded nightly snapshots never enter the rating track record',()=>{
  assert.equal(toRatingHistory({eligible:false,rating:'EXCLUDED'}),null)
})

test('hold ratings do not create pretend trade entries',()=>{
  assert.equal(toRatingHistory({eligible:true,rating:'HOLD_WAIT'}),null)
})
