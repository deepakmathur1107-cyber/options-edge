const test=require('node:test')
const assert=require('node:assert/strict')
const {exclusion,UNIVERSE,MIN_PRICE,MIN_AVERAGE_VOLUME}=require('../api/cron/build-stock-universe')._test

const healthy={status:'ACCEPTABLE',score:70,coverage:80}

test('nightly universe excludes penny stocks',()=>{
  assert.match(exclusion({price:MIN_PRICE-.01,averageVolume:MIN_AVERAGE_VOLUME,health:healthy}),/penny-stock/)
})

test('nightly universe excludes low-liquidity stocks',()=>{
  assert.match(exclusion({price:20,averageVolume:MIN_AVERAGE_VOLUME-1,health:healthy}),/volume/)
})

test('nightly universe requires medium-to-high fundamentals',()=>{
  assert.match(exclusion({price:20,averageVolume:1000000,health:{status:'FUNDAMENTAL_RISK',score:64,coverage:100}}),/quality/)
  assert.match(exclusion({price:20,averageVolume:1000000,health:{status:'HEALTHY',score:90,coverage:60}}),/coverage/)
  assert.equal(exclusion({price:20,averageVolume:1000000,health:healthy}),null)
})

test('nightly universe is broader than the former ten-stock list and includes PDD',()=>{
  assert.ok(UNIVERSE.length>300)
  assert.ok(UNIVERSE.includes('PDD'))
})
