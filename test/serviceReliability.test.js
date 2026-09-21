const test = require('node:test')
const assert = require('node:assert/strict')
const { isCronRequest } = require('../api/_lib/cronAuth')
const { createBoundedFetch } = require('../api/_lib/boundedFetch')

test('accepts the Bearer authorization Vercel sends to cron GET requests', () => {
  assert.equal(isCronRequest({ headers: { authorization: 'Bearer expected' } }, 'expected'), true)
  assert.equal(isCronRequest({ headers: { authorization: 'Bearer wrong' } }, 'expected'), false)
})

test('keeps the legacy cron header for controlled admin triggers', () => {
  assert.equal(isCronRequest({ headers: { 'x-cron-secret': 'expected' } }, 'expected'), true)
  assert.equal(isCronRequest({ headers: {} }, ''), false)
})

test('bounded fetch aborts an unavailable provider instead of hanging', async () => {
  const originalFetch = global.fetch
  global.fetch = (_input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  try {
    await assert.rejects(createBoundedFetch(10)('https://example.test'), { name: 'AbortError' })
  } finally {
    global.fetch = originalFetch
  }
})
