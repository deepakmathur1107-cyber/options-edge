const test = require('node:test')
const assert = require('node:assert/strict')

test('Finnhub profile remains available when API-Ninjas rejects a valid ticker', async () => {
  const originalFetch = global.fetch
  const originalNinjas = process.env.API_NINJAS_KEY
  const originalFinnhub = process.env.FINNHUB_API_KEY
  process.env.API_NINJAS_KEY = 'ninjas-test'
  process.env.FINNHUB_API_KEY = 'finnhub-test'
  delete require.cache[require.resolve('../api/_lib/fundamentals')]

  global.fetch = async input => {
    const url = String(input)
    if (url.includes('api.api-ninjas.com/v1/ticker')) return { ok: false, status: 400 }
    if (url.includes('/stock/profile2')) return { ok: true, json: async () => ({ ticker: 'AAPL', name: 'Apple', marketCapitalization: 3000, finnhubIndustry: 'Technology' }) }
    if (url.includes('/calendar/earnings')) return { ok: true, json: async () => ({ earningsCalendar: [] }) }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    const { _test } = require('../api/_lib/fundamentals')
    const result = await _test.fetchBaseFundamentals('AAPL')
    assert.equal(result.ticker, 'AAPL')
    assert.equal(result.market_cap, 3_000_000_000)
    assert.equal(result.sector, 'Technology')
  } finally {
    global.fetch = originalFetch
    if (originalNinjas === undefined) delete process.env.API_NINJAS_KEY
    else process.env.API_NINJAS_KEY = originalNinjas
    if (originalFinnhub === undefined) delete process.env.FINNHUB_API_KEY
    else process.env.FINNHUB_API_KEY = originalFinnhub
    delete require.cache[require.resolve('../api/_lib/fundamentals')]
  }
})
