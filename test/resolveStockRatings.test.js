const test=require('node:test')
const assert=require('node:assert/strict')
const {evaluateDailyBar}=require('../api/cron/resolve-stock-ratings')._test

test('uses daily high and low rather than close for stock exits',()=>{
  assert.equal(evaluateDailyBar({last:101,high:111,low:99},{target_price:110,stop_price:95}).outcome,'TARGET')
  assert.equal(evaluateDailyBar({last:99,high:102,low:94},{target_price:110,stop_price:95}).outcome,'STOP')
})

test('same-day target and stop collision is counted conservatively',()=>{
  assert.equal(evaluateDailyBar({last:103,high:111,low:94},{target_price:110,stop_price:95}).outcome,'STOP')
})
