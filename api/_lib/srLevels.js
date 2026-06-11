// api/_lib/srLevels.js
// S/R: Fib retracement + swing levels + MAs.
// Handles both trending and mean-reverting scenarios correctly.
// When price is at recent lows (no swing lows below), uses recent consolidation
// zone and Fib extension for support. Validated against real Tradier data.
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

// Fib retracement from dominant swing in lookback window
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

// Fib extension levels (project below swing low — for when price is breaking down)
function computeFibExtensions(swingHigh, swingLow) {
  const range = swingHigh - swingLow
  // Extensions below swing low: 0%, 23.6%, 38.2%, 50%, 61.8%
  return [0, 0.236, 0.382, 0.500, 0.618].map(r => ({
    price:  +(swingLow - range * r).toFixed(2),
    ratio:  r,
    label:  `Ext ${(r * 100).toFixed(1)}%`,
    weight: r === 0 ? 3 : 1,
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

// Find nearest level in direction, minimum minPct away from price
function nearestLevel(candidates, price, direction, minPct = 0.003) {
  const side  = direction === 'above'
  return candidates
    .filter(c => side
      ? c.price > price * (1 + minPct)
      : c.price < price * (1 - minPct))
    .sort((a, b) => side ? a.price - b.price : b.price - a.price)[0] || null
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
  const fibExts = computeFibExtensions(swingHigh, swingLow)

  // Swing detection — use full 90-day window
  const days90 = allDays.slice(-90)
  const { highs: h90, lows: l90 } = findSwings(days90, 2)
  const allResists  = clusterLevels(h90.filter(h => h.price > price))
  const allSupports = clusterLevels(l90.filter(l => l.price < price))

  // Also check last 20 days for very recent swing lows (consolidation zones)
  const days20 = allDays.slice(-20)
  const { highs: h20, lows: l20 } = findSwings(days20, 1)
  const recentSupports = clusterLevels(l20.filter(l => l.price < price))
  const recentResists  = clusterLevels(h20.filter(h => h.price > price))

  // ── R1: nearest swing high above price ──────────────────────────────────
  // Priority: recent swing high → 90-day swing high → Fib retracement
  const r1Swing = nearestLevel([...recentResists, ...allResists], price, 'above', 0.003)
  const r1Fib   = nearestLevel(
    fibs.filter(f => !(f.ratio === 0.500 && Math.abs(f.price - price) / price < 0.015)),
    price, 'above', 0.003
  )

  let r1, r1source
  if (r1Swing) {
    // Check if a Fib level is closer than the swing high
    if (r1Fib && (r1Fib.price - price) < (r1Swing.price - price) - price * 0.02) {
      r1 = r1Fib.price; r1source = r1Fib.label
    } else {
      r1 = r1Swing.price; r1source = 'swing'
    }
  } else if (r1Fib) {
    r1 = r1Fib.price; r1source = r1Fib.label
  } else {
    r1 = +pivots.r1.toFixed(2); r1source = 'pivot'
  }
  r1 = +r1.toFixed(2)

  // ── S1: nearest support below price ─────────────────────────────────────
  // Priority: recent swing low (last 20d) → 90-day swing low → MA → Fib → pivot
  // Key insight: if price is AT a new recent low, use the recent consolidation
  // zone (lowest recent lows) or the nearest MA below as S1

  const s1Recent = nearestLevel(recentSupports, price, 'below', 0.003)
  const s1Swing  = nearestLevel(allSupports,    price, 'below', 0.003)

  // Nearest MA below price
  const maBelow = [ma50, ma200]
    .filter(m => m && m < price * 0.997)
    .sort((a, b) => b - a)  // closest first

  // Usable Fib for support (skip 50% if within 1.5% of price)
  const s1FibCands = fibs.filter(f =>
    f.price < price * 0.997 &&
    !(f.ratio === 0.500 && Math.abs(f.price - price) / price < 0.015)
  )
  const s1Fib = s1FibCands.sort((a, b) => b.price - a.price)[0]  // nearest below

  // Pick S1: prefer actual swing lows, then MA, then Fib
  let s1, s1source
  if (s1Recent) {
    s1 = s1Recent.price; s1source = 'recent swing'
  } else if (s1Swing) {
    s1 = s1Swing.price; s1source = 'swing'
  } else if (maBelow[0]) {
    s1 = maBelow[0]; s1source = 'MA'
  } else if (s1Fib) {
    s1 = s1Fib.price; s1source = s1Fib.label
  } else {
    s1 = +pivots.s1.toFixed(2); s1source = 'pivot'
  }
  s1 = +s1.toFixed(2)

  // ── R2: next resistance above R1 ────────────────────────────────────────
  const r2Cands = [
    ...allResists.filter(c => c.price > r1 * 1.005 && c.price < price * 1.15),
    ...fibs.filter(f => f.price > r1 * 1.005 && f.price < price * 1.15)
      .map(f => ({ price: f.price, touches: 1 })),
  ]
  const r2res = nearestLevel(r2Cands, r1, 'above', 0.005)
  const r2 = r2res
    ? +r2res.price.toFixed(2)
    : +(Math.min(Math.max(pivots.r2, r1 * 1.03), price * 1.15)).toFixed(2)

  // ── S2: next support below S1 ───────────────────────────────────────────
  const s2Cands = [
    ...allSupports.filter(c => c.price < s1 * 0.995 && c.price > price * 0.85),
    ...fibs.filter(f => f.price < s1 * 0.995 && f.price > price * 0.85)
      .map(f => ({ price: f.price, touches: 1 })),
  ]
  const s2res = nearestLevel(s2Cands, s1, 'below', 0.005)
  const s2 = s2res
    ? +s2res.price.toFixed(2)
    : +(Math.max(Math.min(pivots.s2, s1 * 0.97), price * 0.85)).toFixed(2)

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
    _version: 'v4-swing-fib-ma',
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
