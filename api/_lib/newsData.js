/**
 * api/_lib/newsData.js
 * Fetches market prices (Tradier) and news headlines (Finnhub).
 * Returns a clean data object for the brief generator.
 * No AI calls — pure data fetching.
 */

async function fetchPrices() {
  const snap = { spy: null, qqq: null, vixy: null, uso: null, spyChange: null, qqqChange: null }
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
      snap.spy       = get('SPY')
      snap.qqq       = get('QQQ')
      snap.vixy      = get('VIXY')
      snap.uso       = get('USO')
      snap.spyChange = get('SPY', 'change_percentage')
      snap.qqqChange = get('QQQ', 'change_percentage')
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
