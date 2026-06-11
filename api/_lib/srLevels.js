// api/_lib/srLevels.js
// S/R using Fibonacci retracement + swing levels + MAs.
// S1/R1 from 45-day swings + Fib confluence. S2/R2 from 60-day window.
// S2 capped at 15% below price, R2 capped at 15% above — keeps levels actionable.
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

function computeFibs(days, lookback = 90) {
  const slice     = days.slice(-lookback)
  const swingHigh = Math.max(...slice.map(d => d.high))
  const swingLow  = Math.min(...slice.map(d => d.low))
  const range     = swingHigh - swingLow
  if (range < 1) return { levels: [], swingHigh, swingLow }
  return {
    levels: FIB_RATIOS.map(r => ({
      price:  +(swingHigh - range * r).toFixed(2),
      ratio:  r,
      label:  `Fib ${(r * 100).toFixed(1)}%`,
      weight: (r === 0.500 || r === 0.618) ? 3 : (r === 0.382 ? 2 : 1),
    })),
    swingHigh: +swingHigh.toFixed(2),
    swingLow:  +swingLow.toFixed(2),
  }
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

function clusterLevels(levels, pct = 0.006) {
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
  return clusters.sort((a, b) => (b.lastIdx + b.touches * 2) - (a.lastIdx + a.touches * 2))
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

// Pick best level — swing+Fib confluence wins, then nearest swing, then key Fib, then MA
function pickBest(swingClusters, fibLevels, maLevels, price, direction, minPct = 0.003) {
  const side  = direction === 'above'
  const inDir = v => side ? v > price * (1 + minPct) : v < price * (1 - minPct)

  const swings = swingClusters
    .filter(s => inDir(s.price))
    .map(s => {
      const nearFib = fibLevels.find(f => inDir(f.price) && Math.abs(f.price - s.price) / s.price < 0.01)
      return {
        price:  s.price,
        score:  (nearFib ? 10 + nearFib.weight : 0) + s.touches * 2 + (s.lastIdx || 0) * 0.1,
        source: nearFib ? `swing + ${nearFib.label}` : 'swing',
      }
    })
    .sort((a, b) => {
      const da = Math.abs(a.price - price)
      const db = Math.abs(b.price - price)
      if (Math.abs(da - db) / price > 0.02) return da - db  // >2% apart: pick nearest
      return b.score - a.score                               // close: pick higher score
    })

  if (swings.length) return { price: swings[0].price, source: swings[0].source }

  // No swing — fall through to key Fib levels
  const keyFibs = fibLevels
    .filter(f => inDir(f.price) && (f.ratio === 0.382 || f.ratio === 0.500 || f.ratio === 0.618))
    .sort((a, b) => side ? a.price - b.price : b.price - a.price)
  if (keyFibs.length) return { price: keyFibs[0].price, source: keyFibs[0].label }

  const anyFib = fibLevels.filter(f => inDir(f.price))
    .sort((a, b) => side ? a.price - b.price : b.price - a.price)
  if (anyFib.length) return { price: anyFib[0].price, source: anyFib[0].label }

  // MA last resort
  const ma = maLevels.filter(m => m && inDir(m)).sort((a, b) => side ? a - b : b - a)
  return ma[0] ? { price: ma[0], source: 'MA' } : null
}

async function getSRLevels(ticker) {
  const allDays = await fetchHistory(ticker)
  if (allDays.length < 10) throw new Error(`Insufficient history for ${ticker}`)

  const price  = allDays[allDays.length - 1].close
  const last   = allDays[allDays.length - 1]
  const pivots = pivotPoints(last)
  const ma200  = sma(allDays, 200)
  const ma50   = sma(allDays, 50)

  // Fib from 90-day dominant swing
  const { levels: fibs, swingHigh, swingLow } = computeFibs(allDays, 90)

  // S1/R1 — 45-day window catches recent swings without going too far back
  const recent = allDays.slice(-45)
  const { highs: rH, lows: rL } = findSwings(recent, 2)
  const recentResists  = clusterLevels(rH.filter(h => h.price > price))
  const recentSupports = clusterLevels(rL.filter(l => l.price < price))

  const s1res = pickBest(recentSupports, fibs, [ma50, ma200], price, 'below', 0.003)
  const r1res = pickBest(recentResists,  fibs, [ma50, ma200], price, 'above', 0.003)

  const s1 = s1res ? +s1res.price.toFixed(2) : +pivots.s1.toFixed(2)
  const r1 = r1res ? +r1res.price.toFixed(2) : +pivots.r1.toFixed(2)

  // S2/R2 — 60-day window, must be further than S1/R1
  // Cap at 15% from price so extreme crash lows don't show as S2
  const medium = allDays.slice(-60)
  const { highs: mH, lows: mL } = findSwings(medium, 3)
  const medResists  = clusterLevels(mH.filter(h => h.price > r1 * 1.005 && h.price < price * 1.15))
  const medSupports = clusterLevels(mL.filter(l => l.price < s1 * 0.995 && l.price > price * 0.85))

  const s2res = pickBest(medSupports, fibs.filter(f => f.price < s1 * 0.995 && f.price > price * 0.85), [], price, 'below', 0.003)
  const r2res = pickBest(medResists,  fibs.filter(f => f.price > r1 * 1.005 && f.price < price * 1.15), [], price, 'above', 0.003)

  const s2 = s2res
    ? +s2res.price.toFixed(2)
    : +(Math.max(Math.min(pivots.s2, s1 * 0.97), price * 0.85)).toFixed(2)
  const r2 = r2res
    ? +r2res.price.toFixed(2)
    : +(Math.min(Math.max(pivots.r2, r1 * 1.03), price * 1.15)).toFixed(2)

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
