// api/test-tradier.js
// TEMPORARY diagnostic endpoint — remove after confirming Tradier works
// Visit: https://your-app.vercel.app/api/test-tradier

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')

  const token = process.env.TRADIER_TOKEN
  const mode  = process.env.TRADIER_MODE || 'production'
  const base  = mode === 'sandbox'
    ? 'https://sandbox.tradier.com/v1'
    : 'https://api.tradier.com/v1'

  const result = {
    config: {
      mode,
      base,
      tokenSet:    !!token,
      tokenPrefix: token ? token.substring(0,8)+'...' : 'NOT SET',
      tokenHasBearer: token ? token.toLowerCase().startsWith('bearer') : false,
    },
    tests: {}
  }

  if (!token) {
    return res.status(200).json({ ...result, error: 'TRADIER_TOKEN not set in Vercel env vars' })
  }

  // Test 1: SPY quote (always works)
  try {
    const r = await fetch(`${base}/markets/quotes?symbols=SPY&greeks=false`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    const text = await r.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.substring(0,200) } }
    result.tests.SPY = { status: r.status, price: data?.quotes?.quote?.last, raw: data }
  } catch(e) {
    result.tests.SPY = { error: e.message }
  }

  // Test 2: SPX quote (may fail in sandbox)
  try {
    const r = await fetch(`${base}/markets/quotes?symbols=SPX&greeks=false`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    const text = await r.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.substring(0,200) } }
    result.tests.SPX = { status: r.status, price: data?.quotes?.quote?.last, raw: data }
  } catch(e) {
    result.tests.SPX = { error: e.message }
  }

  // Test 3: QQQ quote
  try {
    const r = await fetch(`${base}/markets/quotes?symbols=QQQ&greeks=false`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    const text = await r.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.substring(0,200) } }
    result.tests.QQQ = { status: r.status, price: data?.quotes?.quote?.last }
  } catch(e) {
    result.tests.QQQ = { error: e.message }
  }

  return res.status(200).json(result)
}
