/**
 * api/_lib/newsData.js
 * Fetches market prices (Tradier) and news headlines (Finnhub).
 * Returns a clean data object for the brief generator.
 * No AI calls — pure data fetching.
 */

function getSession() {
  const nowET  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et     = new Date(nowET)
  const mins   = et.getHours() * 60 + et.getMinutes()
  const isWday = et.getDay() > 0 && et.getDay() < 6
  if (!isWday) return 'closed'
  if (mins >= 4*60   && mins < 9*60+30) return 'pre'
  if (mins >= 9*60+30 && mins < 16*60)  return 'regular'
  if (mins >= 16*60   && mins < 20*60)  return 'after'
  return 'closed'
}

async function fetchPrices() {
  const session = getSession()
  const snap = { spy: null, qqq: null, vixy: null, uso: null, spyChange: null, qqqChange: null, session }
  try {
    const r = await fetch(
      'https://api.tradier.com/v1/markets/quotes?symbols=SPY,QQQ,VIXY,USO',
      {
        headers: { Authorization: `Bearer ${process.env.TRADIER_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (r.ok) {
      const data   = await r.json()
      const quotes = data?.quotes?.quote || []
      const arr    = Array.isArray(quotes) ? quotes : [quotes]
      const get    = (sym, field = 'last') => arr.find(q => q.symbol === sym)?.[field] ?? null

      // Use premarket prices during pre-session for more accurate readout
      if (session === 'pre') {
        snap.spy       = parseFloat(get('SPY', 'pre_market_price') || get('SPY')) || null
        snap.qqq       = parseFloat(get('QQQ', 'pre_market_price') || get('QQQ')) || null
        snap.spyChange = parseFloat(get('SPY', 'pre_market_change_percentage') || get('SPY','change_percentage')) || null
        snap.qqqChange = parseFloat(get('QQQ', 'pre_market_change_percentage') || get('QQQ','change_percentage')) || null
      } else {
        snap.spy       = get('SPY')
        snap.qqq       = get('QQQ')
        snap.spyChange = get('SPY', 'change_percentage')
        snap.qqqChange = get('QQQ', 'change_percentage')
      }
      snap.vixy = get('VIXY')
      snap.uso  = get('USO')
    }
  } catch (e) { console.warn('[newsData] Tradier failed:', e.message) }
  return snap
}

async function fetchNews() {
  const key = process.env.FINNHUB_API_KEY
  if (!key) { console.warn('[newsData] FINNHUB_API_KEY not set'); return [] }

  try {
    // General market news from Finnhub
    const r = await fetch(
      `https://finnhub.io/api/v1/news?category=general&token=${key}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!r.ok) { console.warn('[newsData] Finnhub news failed:', r.status); return [] }
    const data = await r.json()

    // Filter to last 8 hours, take top 8 by recency
    const cutoff = Date.now() - 8 * 60 * 60 * 1000
    return (Array.isArray(data) ? data : [])
      .filter(n => n.datetime * 1000 > cutoff)
      .slice(0, 8)
      .map(n => ({ headline: n.headline, source: n.source, url: n.url, time: n.datetime }))
  } catch (e) { console.warn('[newsData] Finnhub fetch failed:', e.message); return [] }
}

async function fetchCalendar() {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []

  try {
    const today = new Date().toISOString().slice(0, 10)
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${key}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!r.ok) return []
    const data = await r.json()
    return (data?.economicCalendar || [])
      .filter(e => e.impact === 'high' || e.impact === 'medium')
      .slice(0, 5)
      .map(e => `${e.event}${e.actual != null ? ` — actual: ${e.actual} (est: ${e.estimate})` : ''}`)
  } catch (e) { console.warn('[newsData] Finnhub calendar failed:', e.message); return [] }
}

async function fetchMarketData() {
  const [prices, news, calendar] = await Promise.all([fetchPrices(), fetchNews(), fetchCalendar()])
  return { prices, news, calendar }
}

module.exports = { fetchMarketData, fetchPrices, fetchNews }
