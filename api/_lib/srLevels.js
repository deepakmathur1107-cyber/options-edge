// api/_lib/srLevels.js
// S/R using Fibonacci retracement + swing levels + MAs.
// Fib computed from 90-day range. S1/R1 must be meaningfully away from price.
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

// Fib retracement levels from the dominant swing (highest high to lowest low)
// Returns levels as price points between the swing high and low
function computeFibs(days, lookback = 90) {
  const slice     = days.slice(-lookback)
  const swingHigh = Math.max(...slice.map(d => d.high))
  const swingLow  = Math.min(...slice.map(d => d.low))
  const range     = swingHigh - swingLow
  if (range < 1) return { levels: [], swingHigh, swingLow }
  const levels = FIB_RATIOS.map(r => ({
    price: +(swingHigh - range * r).toFixed(2),
    ratio: r,
    label: `Fib ${(r * 100).toFixed(1)}%`,
    // Key levels get higher weight
    weight: (r === 0.500 || r === 0.618) ? 3 : (r === 0.382 ? 2 : 1),
  }))
  return { levels, swingHigh: +swingHigh.toFixed(2), swingLow: +swingLow.toFixed(2) }
}

function findSwings(days, win = 3) {
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

function clusterLevels(levels, pct = 0.006) {
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
  return clusters
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

// Build a ranked list of candidate S/R levels from both swing clusters and Fib
// Confluence (swing + fib nearby) gets highest score
// Sorted nearest-first in given direction
function buildCandidates(swingClusters, fibLevels, price, direction, minDist = 0.005) {
  const merged = []

  // Add swing levels
  for (const s of swingClusters) {
    const d = direction === 'above' ? s.price - price : price - s.price
    if (d <= price * minDist) continue  // too close to current price
    const nearFib = fibLevels.find(f =>
      Math.abs(f.price - s.price) / s.price < 0.008 &&
      (direction === 'above' ? f.price > price : f.price < price)
    )
    merged.push({
      price:   +s.price.toFixed(2),
      weight:  nearFib ? (s.touches + nearFib.weight + 2) : s.touches,
      source:  nearFib ? `swing + ${nearFib.label}` : 'swing',
    })
  }

  // Add standalone Fib levels not already covered by swing
  for (const f of fibLevels) {
    const d = direction === 'above' ? f.price - price : price - f.price
    if (d <= price * minDist) continue  // too close
    const alreadyCovered = merged.find(c => Math.abs(c.price - f.price) / f.price < 0.008)
    if (!alreadyCovered) {
      merged.push({ price: f.price, weight: f.weight, source: f.label })
    }
  }

  // Sort nearest first
  merged.sort((a, b) =>
    direction === 'above' ? a.price - b.price : b.price - a.price
  )

  return merged
}

async function getSRLevels(ticker) {
  const allDays = await fetchHistory(ticker)
  if (allDays.length < 10) throw new Error(`Insufficient history for ${ticker}`)

  const price  = allDays[allDays.length - 1].close
  const last   = allDays[allDays.length - 1]
  const pivots = pivotPoints(last)
  const ma200  = sma(allDays, 200)
  const ma50   = sma(allDays, 50)

  // Fib from 90-day range
  const { levels: fibs, swingHigh, swingLow } = computeFibs(allDays, 90)

  // Swings from last 30 days for S1/R1
  const recent = allDays.slice(-30)
  const { highs: rH, lows: rL } = findSwings(recent, 2)
  const recentResists  = clusterLevels(rH.filter(h => h.price > price))
  const recentSupports = clusterLevels(rL.filter(l => l.price < price))

  // S1/R1 — nearest meaningful level (swing or Fib), must be >0.5% from price
  const supportCands = buildCandidates(recentSupports, fibs.filter(f => f.price < price), price, 'below', 0.005)
  const resistCands  = buildCandidates(recentResists,  fibs.filter(f => f.price > price), price, 'above', 0.005)

  let s1 = supportCands[0]?.price || null
  let r1 = resistCands[0]?.price  || null

  // MA as S1/R1 only if closer than current best AND more than 0.5% away
  const maBelow = [ma50, ma200].filter(m => m && m < price && (price - m) / price > 0.005)
    .sort((a, b) => b - a)
  const maAbove = [ma50, ma200].filter(m => m && m > price && (m - price) / price > 0.005)
    .sort((a, b) => a - b)

  if (!s1 && maBelow[0]) s1 = maBelow[0]
  if (!r1 && maAbove[0]) r1 = maAbove[0]

  // Final fallback to classic pivot
  s1 = s1 ? +s1.toFixed(2) : +pivots.s1.toFixed(2)
  r1 = r1 ? +r1.toFixed(2) : +pivots.r1.toFixed(2)

  // S2/R2 — next level beyond S1/R1 from 60-day swings + Fib
  const medium = allDays.slice(-60)
  const { highs: mH, lows: mL } = findSwings(medium, 3)
  const medResists  = clusterLevels(mH.filter(h => h.price > price))
  const medSupports = clusterLevels(mL.filter(l => l.price < price))

  const s2Cands = buildCandidates(medSupports, fibs.filter(f => f.price < s1), price, 'below', 0.005)
    .filter(c => c.price < s1 - price * 0.01)
  const r2Cands = buildCandidates(medResists, fibs.filter(f => f.price > r1), price, 'above', 0.005)
    .filter(c => c.price > r1 + price * 0.01)

  const s2 = s2Cands[0]?.price ? +s2Cands[0].price.toFixed(2) : +(Math.min(pivots.s2, s1 * 0.97)).toFixed(2)
  const r2 = r2Cands[0]?.price ? +r2Cands[0].price.toFixed(2) : +(Math.max(pivots.r2, r1 * 1.03)).toFixed(2)

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
    pivot: +pivots.pp.toFixed(2),
    ma200: ma200 ? +ma200.toFixed(2) : null,
    ma50:  ma50  ? +ma50.toFixed(2)  : null,
    position, contextLine,
    fibSwingHigh: swingHigh,
    fibSwingLow:  swingLow,
    fibs: fibs.map(f => ({ price: f.price, label: f.label })),
    week52High: +week52High.toFixed(2),
    week52Low:  +week52Low.toFixed(2),
  }
}

module.exports = { getSRLevels }
