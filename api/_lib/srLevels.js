Replace the entire contents of api/_lib/srLevels.js with this:

// api/_lib/srLevels.js
// S/R using Fibonacci retracement + swing highs/lows + MAs.
// S1/R1 from 20-day swings + Fib confluence. S2/R2 from 60-day window.
// CommonJS only.

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

// Fibonacci retracement levels from dominant swing in last N days
function fibLevels(days, lookback = 60) {
  const slice = days.slice(-lookback)
  const hi    = Math.max(...slice.map(d => d.high))
  const lo    = Math.min(...slice.map(d => d.low))
  const range = hi - lo
  if (range < 0.01) return []
  // Retracement from high down: 0% = hi, 100% = lo
  return FIB_RATIOS.map(r => ({
    price: +(hi - range * r).toFixed(2),
    ratio: r,
    label: `Fib ${(r * 100).toFixed(1)}%`,
  }))
}

function findSwings(days, win = 2) {
  const highs = [], lows = []
  for (let i = win; i < days.length - win; i++) {
    const sl   = days.slice(i - win, i + win + 1)
    const maxH = Math.max(...sl.map(d => d.high))
    const minL = Math.min(...sl.map(d => d.low))
    if (days[i].high >= maxH) highs.push({ price: days[i].high, idx: i })
    if (days[i].low  <= minL) lows.push({  price: days[i].low,  idx: i })
  }
  return { highs, lows }
}

function clusterLevels(levels, pct = 0.005) {
  const clusters = []
  for (const lvl of levels) {
    const ex = clusters.find(c => Math.abs(c.price - lvl.price) / c.price < pct)
    if (ex) {
      ex.price   = (ex.price * ex.touches + lvl.price) / (ex.touches + 1)
      ex.touches += 1
      ex.lastIdx  = Math.max(ex.lastIdx || 0, lvl.idx || 0)
    } else {
      clusters.push({ price: lvl.price, touches: 1, lastIdx: lvl.idx || 0 })
    }
  }
  return clusters
}

// Merge swing clusters + fib levels, boost weight when both coincide within 0.5%
function mergeLevels(swingClusters, fibs, price, direction) {
  const candidates = []

  for (const s of swingClusters) {
    if (direction === 'above' ? s.price <= price : s.price >= price) continue
    const nearFib = fibs.find(f => Math.abs(f.price - s.price) / s.price < 0.005)
    candidates.push({
      price:      s.price,
      weight:     nearFib ? 5 : 2,  // confluence = strongest level
      source:     nearFib ? `swing+${nearFib.label}` : 'swing',
      touches:    s.touches,
    })
  }

  for (const f of fibs) {
    if (direction === 'above' ? f.price <= price : f.price >= price) continue
    const alreadyMerged = candidates.find(c => Math.abs(c.price - f.price) / f.price < 0.005)
    if (!alreadyMerged) {
      candidates.push({
        price:   f.price,
        weight:  (f.ratio === 0.500 || f.ratio === 0.618) ? 3 : 1,
        source:  f.label,
        touches: 1,
      })
    }
  }

  // Sort by proximity to price (nearest first)
  return candidates.sort((a, b) =>
    direction === 'above'
      ? a.price - b.price
      : b.price - a.price
  )
}

function sma(days, n) {
  const slice = days.slice(-n).map(d => d.close)
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null
}

function pivotPoints(day) {
  const { high: H, low: L, close: C } = day
  const PP = (H + L + C) / 3
  return { pp: PP, r1: 2*PP - L, r2: PP + (H - L), s1: 2*PP - H, s2: PP - (H - L) }
}

async function getSRLevels(ticker) {
  const allDays = await fetchHistory(ticker)
  if (allDays.length < 10) throw new Error(`Insufficient history for ${ticker}`)

  const price  = allDays[allDays.length - 1].close
  const last   = allDays[allDays.length - 1]
  const pivots = pivotPoints(last)
  const ma200  = sma(allDays, 200)
  const ma50   = sma(allDays, 50)

  // Fib levels from 60-day dominant swing
  const fibs60 = fibLevels(allDays, 60)

  // S1/R1 — swing from last 20 days merged with Fib
  const recent = allDays.slice(-20)
  const { highs: rH, lows: rL } = findSwings(recent, 2)
  const recentResists  = clusterLevels(rH.filter(h => h.price > price))
  const recentSupports = clusterLevels(rL.filter(l => l.price < price))

  const supportCands = mergeLevels(recentSupports, fibs60, price, 'below')
  const resistCands  = mergeLevels(recentResists,  fibs60, price, 'above')

  let s1 = supportCands[0]?.price || null
  let r1 = resistCands[0]?.price  || null

  // MA fallback only if no swing/fib found nearby
  if (!s1) s1 = [ma50, ma200].filter(m => m && m < price).sort((a, b) => b - a)[0] || null
  if (!r1) r1 = [ma50, ma200].filter(m => m && m > price).sort((a, b) => a - b)[0] || null

  s1 = s1 || pivots.s1
  r1 = r1 || pivots.r1

  // S2/R2 — 60-day swing merged with Fib, must be further than S1/R1
  const medium = allDays.slice(-60)
  const { highs: mH, lows: mL } = findSwings(medium, 3)
  const medResists  = clusterLevels(mH.filter(h => h.price > price))
  const medSupports = clusterLevels(mL.filter(l => l.price < price))

  const s2Cands = mergeLevels(medSupports, fibs60, price, 'below').filter(c => c.price < s1)
  const r2Cands = mergeLevels(medResists,  fibs60, price, 'above').filter(c => c.price > r1)

  let s2 = s2Cands[0]?.price || Math.min(pivots.s2, s1 * 0.97)
  let r2 = r2Cands[0]?.price || Math.max(pivots.r2, r1 * 1.03)

  const week52High = Math.max(...allDays.map(d => d.high))
  const week52Low  = Math.min(...allDays.map(d => d.low))

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
    fibs:  fibs60.map(f => ({ price: f.price, label: f.label })),
    week52High: +week52High.toFixed(2),
    week52Low:  +week52Low.toFixed(2),
  }
}

module.exports = { getSRLevels }
