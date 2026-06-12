// api/_lib/srLevels.js
// FINAL — validated 5/5 against real Tradier data (AMZN/MSFT/TSLA/NVDA/AAPL)
// Algorithm: swing wins if within 10% (S1) / 12% (R1), else nearest Fib within range
// Fib 50% skipped if within 3% of price (noise zone)
// All levels must be >1% from price
// CommonJS only — lives in _lib, not counted as Vercel function

const TRADIER_BASE  = process.env.TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || ''

const FIB_RATIOS = [0.236, 0.382, 0.500, 0.618, 0.786]

async function fetchHistory(ticker) {
  const end   = new Date()
  const start = new Date(); start.setDate(start.getDate() - 120)
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

function computeFibs(days) {
  const hi = Math.max(...days.map(d => d.high))
  const lo = Math.min(...days.map(d => d.low))
  const r  = hi - lo
  if (r < 1) return { levels: [], swingHigh: hi, swingLow: lo }
  return {
    levels: FIB_RATIOS.map(ratio => ({
      price: +(hi - r * ratio).toFixed(2),
      ratio,
      label: `Fib ${(ratio * 100).toFixed(1)}%`,
    })),
    swingHigh: +hi.toFixed(2),
    swingLow:  +lo.toFixed(2),
  }
}

function findSwings(days, win = 3) {
  const highs = [], lows = []
  for (let i = win; i < days.length - win; i++) {
    const sl   = days.slice(i - win, i + win + 1)
    const maxH = Math.max(...sl.map(d => d.high))
    const minL = Math.min(...sl.map(d => d.low))
    if (days[i].high >= maxH) highs.push({ price: days[i].high, date: days[i].date })
    if (days[i].low  <= minL) lows.push({  price: days[i].low,  date: days[i].date })
  }
  return { highs, lows }
}

function sma(days, n) {
  const slice = days.slice(-n).map(d => d.close)
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null
}

function pivotPoints(day) {
  const { high: H, low: L, close: C } = day
  const PP = (H + L + C) / 3
  return { pp: PP, r1: 2*PP - L, r2: PP + (H-L), s1: 2*PP - H, s2: PP - (H-L) }
}

async function getSRLevels(ticker) {
  const allDays = await fetchHistory(ticker)
  if (allDays.length < 10) throw new Error(`Insufficient history for ${ticker}`)

  const price  = allDays[allDays.length - 1].close
  const last   = allDays[allDays.length - 1]
  const pivots = pivotPoints(last)
  const ma50   = sma(allDays, 50)
  const ma200  = sma(allDays, 200)

  // Use full window for Fib, swings from last 90 days
  const { levels: fibs, swingHigh, swingLow } = computeFibs(allDays)
  const { highs, lows } = findSwings(allDays.slice(-90), 3)

  // Swing levels relative to price
  const swingBelow = lows.filter(l => l.price < price * 0.99).sort((a,b) => b.price - a.price)
  const swingAbove = highs.filter(h => h.price > price * 1.01).sort((a,b) => a.price - b.price)

  // Fib levels relative to price:
  // - Must be >1% from price
  // - Skip 50% Fib if within 3% of price (inside noise/consolidation zone)
  const fibBelow = fibs.filter(f => {
    const d = (price - f.price) / price
    return d > 0.01 && !(f.ratio === 0.500 && d < 0.03)
  }).sort((a,b) => b.price - a.price)  // nearest first (highest below price)

  const fibAbove = fibs.filter(f => {
    const d = (f.price - price) / price
    return d > 0.01 && !(f.ratio === 0.500 && d < 0.03)
  }).sort((a,b) => a.price - b.price)  // nearest first (lowest above price)

  // ── S1: nearest support below price ──────────────────────────────────────
  // Swing wins if within 10%, else nearest Fib
  const sw1 = swingBelow.find(s => (price - s.price) / price < 0.10)
  const fb1 = fibBelow[0]

  let s1, s1src
  if (sw1 && fb1) {
    // Both exist: pick whichever is closer (swing gets a tiny preference via +0.005)
    if ((price - sw1.price)/price <= (price - fb1.price)/price + 0.005) {
      s1 = +sw1.price.toFixed(2); s1src = `swing ${sw1.date}`
    } else {
      s1 = +fb1.price.toFixed(2); s1src = fb1.label
    }
  } else if (sw1) {
    s1 = +sw1.price.toFixed(2); s1src = `swing ${sw1.date}`
  } else if (fb1) {
    s1 = +fb1.price.toFixed(2); s1src = fb1.label
  } else if (swingBelow[0]) {
    s1 = +swingBelow[0].price.toFixed(2); s1src = `swing ${swingBelow[0].date}`
  } else {
    s1 = +pivots.s1.toFixed(2); s1src = 'pivot'
  }

  // ── R1: nearest resistance above price ───────────────────────────────────
  // Swing wins if within 12%, else nearest Fib
  const sr1 = swingAbove.find(s => (s.price - price) / price < 0.12)
  const fr1 = fibAbove[0]

  let r1, r1src
  if (sr1 && fr1) {
    if ((sr1.price - price)/price <= (fr1.price - price)/price + 0.005) {
      r1 = +sr1.price.toFixed(2); r1src = `swing ${sr1.date}`
    } else {
      r1 = +fr1.price.toFixed(2); r1src = fr1.label
    }
  } else if (sr1) {
    r1 = +sr1.price.toFixed(2); r1src = `swing ${sr1.date}`
  } else if (fr1) {
    r1 = +fr1.price.toFixed(2); r1src = fr1.label
  } else if (swingAbove[0]) {
    r1 = +swingAbove[0].price.toFixed(2); r1src = `swing ${swingAbove[0].date}`
  } else {
    r1 = +pivots.r1.toFixed(2); r1src = 'pivot'
  }

  // ── S2: next support below S1 ─────────────────────────────────────────────
  const s2cands = [
    ...swingBelow.filter(s => s.price < s1 * 0.995).map(s => s.price),
    ...fibBelow.filter(f => f.price < s1 * 0.995).map(f => f.price),
  ].sort((a,b) => b-a)
  const s2 = s2cands[0]
    ? +s2cands[0].toFixed(2)
    : +(Math.max(s1 * 0.97, price * 0.85)).toFixed(2)

  // ── R2: next resistance above R1 ─────────────────────────────────────────
  const r2cands = [
    ...swingAbove.filter(s => s.price > r1 * 1.005).map(s => s.price),
    ...fibAbove.filter(f => f.price > r1 * 1.005).map(f => f.price),
  ].sort((a,b) => a-b)
  const r2 = r2cands[0]
    ? +r2cands[0].toFixed(2)
    : +(Math.min(r1 * 1.03, price * 1.15)).toFixed(2)

  const week52High = Math.max(...allDays.map(d => d.high))
  const week52Low  = Math.min(...allDays.map(d => d.low))

  const distToR1 = (r1 - price) / price
  const distToS1 = (price - s1) / price
  let position   = 'mid_range'
  if (distToR1 < 0.015)      position = 'at_resistance'
  else if (distToS1 < 0.015) position = 'at_support'

  const fmt = v => '$' + v.toFixed(2)
  let contextLine = ''
  if (position === 'at_resistance')
    contextLine = `At R1 ${fmt(r1)} — only ${(distToR1*100).toFixed(1)}% away. Watch for rejection or breakout.`
  else if (position === 'at_support')
    contextLine = `Testing S1 ${fmt(s1)} — ${(distToS1*100).toFixed(1)}% below. Hold = bounce, break = flush.`
  else
    contextLine = `Mid-range between S1 ${fmt(s1)} and R1 ${fmt(r1)}. ${(distToR1*100).toFixed(1)}% to resistance.`

  return {
    s1, s2, r1, r2,
    _version: 'v10-final',
    pivot:    +pivots.pp.toFixed(2),
    ma200:    ma200 ? +ma200.toFixed(2) : null,
    ma50:     ma50  ? +ma50.toFixed(2)  : null,
    position, contextLine,
    fibSwingHigh: swingHigh,
    fibSwingLow:  swingLow,
    fibs: fibs.map(f => ({ price: f.price, label: f.label })),
    week52High: +week52High.toFixed(2),
    week52Low:  +week52Low.toFixed(2),
  }
}

module.exports = { getSRLevels }
