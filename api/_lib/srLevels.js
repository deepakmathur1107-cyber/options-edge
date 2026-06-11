// api/_lib/srLevels.js
// Computes Support & Resistance levels from Tradier historical OHLC data.
// Lives in _lib so Vercel does NOT count it as a serverless function.
// CommonJS only.

const TRADIER_BASE  = process.env.TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || ''

async function fetchHistory(ticker) {
  const end   = new Date()
  const start = new Date(); start.setDate(start.getDate() - 90)
  const fmt   = d => d.toISOString().split('T')[0]
  const url   = `${TRADIER_BASE}/markets/history?symbol=${encodeURIComponent(ticker)}&interval=daily&start=${fmt(start)}&end=${fmt(end)}`
  const res   = await fetch(url, {
    headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`History ${res.status}`)
  const data = await res.json()
  const days = data?.history?.day
  if (!days) return []
  return (Array.isArray(days) ? days : [days]).map(d => ({
    date:  d.date,
    open:  parseFloat(d.open),
    high:  parseFloat(d.high),
    low:   parseFloat(d.low),
    close: parseFloat(d.close),
  }))
}

function findSwings(days, win = 5) {
  const highs = [], lows = []
  for (let i = win; i < days.length - win; i++) {
    const sl   = days.slice(i - win, i + win + 1)
    const maxH = Math.max(...sl.map(d => d.high))
    const minL = Math.min(...sl.map(d => d.low))
    if (days[i].high === maxH) highs.push({ price: days[i].high, date: days[i].date })
    if (days[i].low  === minL) lows.push({  price: days[i].low,  date: days[i].date })
  }
  return { highs, lows }
}

function clusterLevels(levels, pct = 0.008) {
  const clusters = []
  for (const lvl of levels) {
    const ex = clusters.find(c => Math.abs(c.price - lvl.price) / c.price < pct)
    if (ex) {
      ex.price   = (ex.price * ex.touches + lvl.price) / (ex.touches + 1)
      ex.touches += 1
    } else {
      clusters.push({ price: lvl.price, touches: 1 })
    }
  }
  return clusters.sort((a, b) => b.touches - a.touches)
}

function pivotPoints(day) {
  const { high: H, low: L, close: C } = day
  const PP = (H + L + C) / 3
  return { pp: PP, r1: 2*PP - L, r2: PP + (H - L), s1: 2*PP - H, s2: PP - (H - L) }
}

function sma(days, n) {
  const slice = days.slice(-n).map(d => d.close)
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null
}

async function getSRLevels(ticker) {
  const days = await fetchHistory(ticker)
  if (days.length < 10) throw new Error(`Insufficient history for ${ticker}`)

  const last   = days[days.length - 1]
  const price  = last.close
  const pivots = pivotPoints(last)
  const ma200  = sma(days, 200)
  const ma50   = sma(days, 50)

  const { highs, lows } = findSwings(days, 5)
  const swingResists  = clusterLevels(highs).filter(c => c.price > price).slice(0, 3)
  const swingSupports = clusterLevels(lows) .filter(c => c.price < price).slice(0, 3)

  const r1 = swingResists[0]?.price  || pivots.r1
  const r2 = swingResists[1]?.price  || pivots.r2
  const s1 = swingSupports[0]?.price || pivots.s1
  const s2 = swingSupports[1]?.price || pivots.s2

  const week52High = Math.max(...days.map(d => d.high))
  const week52Low  = Math.min(...days.map(d => d.low))

  const distToR1 = (r1 - price) / price
  const distToS1 = (price - s1) / price
  let position   = 'mid_range'
  if (distToR1 < 0.015)      position = 'at_resistance'
  else if (distToS1 < 0.015) position = 'at_support'

  const f = v => '$' + v.toFixed(2)
  let contextLine = ''
  if (position === 'at_resistance')
    contextLine = `At R1 ${f(r1)} — only ${(distToR1*100).toFixed(1)}% away. Watch for rejection or breakout.`
  else if (position === 'at_support')
    contextLine = `Testing S1 ${f(s1)} — ${(distToS1*100).toFixed(1)}% below. Hold = bounce, break = flush.`
  else
    contextLine = `Mid-range between S1 ${f(s1)} and R1 ${f(r1)}. ${(distToR1*100).toFixed(1)}% to resistance.`

  return {
    s1:    +s1.toFixed(2),
    s2:    +s2.toFixed(2),
    r1:    +r1.toFixed(2),
    r2:    +r2.toFixed(2),
    pivot: +pivots.pp.toFixed(2),
    ma200: ma200 ? +ma200.toFixed(2) : null,
    ma50:  ma50  ? +ma50.toFixed(2)  : null,
    position, contextLine,
    swingSupports: swingSupports.map(c => ({ price: +c.price.toFixed(2), touches: c.touches })),
    swingResists:  swingResists.map(c => ({ price: +c.price.toFixed(2), touches: c.touches })),
    week52High: +week52High.toFixed(2),
    week52Low:  +week52Low.toFixed(2),
  }
}

module.exports = { getSRLevels }
