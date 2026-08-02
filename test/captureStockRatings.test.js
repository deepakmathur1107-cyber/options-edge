const test = require('node:test')
const assert = require('node:assert/strict')

const { collectInBatches, withTimeout } = require('../api/cron/capture-stock-ratings')._test

test('stock rating capture preserves successful tickers when one ticker fails', async () => {
  const candidates=[{ticker:'GOOD'},{ticker:'FAIL'},{ticker:'ALSO'}]
  const result=await collectInBatches(candidates,async candidate=>{
    if(candidate.ticker==='FAIL') throw new Error('provider unavailable')
    return {ticker:candidate.ticker}
  },2)

  assert.deepEqual(result.rows,[{ticker:'GOOD'},{ticker:'ALSO'}])
  assert.deepEqual(result.failures,[{ticker:'FAIL',error:'provider unavailable'}])
})

test('stock rating capture bounds slow provider calls', async () => {
  await assert.rejects(
    withTimeout(new Promise(()=>{}),5,'Slow provider'),
    /Slow provider timed out after 5ms/,
  )
})
