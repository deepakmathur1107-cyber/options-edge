/**
 * api/quote-test.js  
 * Call from browser: /api/quote-test
 * Shows exactly what token, mode, URL, and raw price fields are used
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')

  const mode  = process.env.TRADIER_MODE  || '(not set)'
  const token = process.env.TRADIER_TOKEN || '(not set)'
  const base  = mode === 'sandbox'
    ? 'https://sandbox.tradier.com/v1'
    : 'https://api.tradier.com/v1'

  const sym = req.query.sym || 'SPY'
  const url = `${base}/markets/quotes?symbols=${sym}&greeks=false`

  let raw = null, httpStatus = null, fetchErr = null
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    httpStatus = r.status
    raw = await r.json()
  } catch(e) { fetchErr = e.message }

  const q = raw?.quotes?.quote
  return res.status(200).json({
    env: {
      TRADIER_MODE:  mode,
      TRADIER_BASE:  base,
      token_prefix:  token.slice(0, 8) + '...',   // first 8 chars only — safe to show
    },
    request: { sym, url },
    response: {
      http_status: httpStatus,
      fetch_error: fetchErr,
      price_fields: q ? {
        last:              q.last,
        bid:               q.bid,
        ask:               q.ask,
        close:             q.close,
        prevclose:         q.prevclose,
        change:            q.change,
        change_percentage: q.change_percentage,
        trade_date:        q.trade_date,
        type:              q.type,
        exch:              q.exch,
      } : '(no quote in response)',
      raw: raw,
    }
  })
}
