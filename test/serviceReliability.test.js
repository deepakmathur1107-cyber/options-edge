const test = require('node:test')
const assert = require('node:assert/strict')
const { isCronRequest } = require('../api/_lib/cronAuth')
const { createBoundedFetch } = require('../api/_lib/boundedFetch')
const fs = require('node:fs')
const path = require('node:path')

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

test('watchdog stops on a database read failure instead of launching self-heal scans', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/cron/watchdog.js'), 'utf8')
  const errorGuard = source.indexOf("if (error) {")
  const selfHeal = source.indexOf("fetch(`${host}/api/cron/scan")
  assert.ok(errorGuard >= 0, 'watchdog must handle a failed database read')
  assert.ok(selfHeal > errorGuard, 'database failure guard must run before self-heal scans')
  assert.match(source, /selfHealStarted:\s*false/)
  assert.match(source, /createBoundedFetch\(5000\)/)
})
