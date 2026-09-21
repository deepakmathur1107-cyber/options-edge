const test = require('node:test')
const assert = require('node:assert/strict')
const { getSessionToken } = require('../api/_lib/auth')

test('prefers an explicit Bearer token', () => {
  assert.equal(getSessionToken({ headers: {
    authorization: 'Bearer header-token',
    cookie: '__session=cookie-token',
  } }), 'header-token')
})

test('accepts Clerk same-origin __session cookie when the header is absent', () => {
  assert.equal(getSessionToken({ headers: {
    cookie: 'theme=dark; __session=cookie%2Etoken%2Evalue; other=1',
  } }), 'cookie.token.value')
})

test('does not accept arbitrary authorization schemes or unrelated cookies', () => {
  assert.equal(getSessionToken({ headers: {
    authorization: 'Basic credentials',
    cookie: 'other=value',
  } }), '')
})
