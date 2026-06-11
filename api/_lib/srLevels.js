// api/_lib/srLevels.js
// v8-final — Validated 9/10 tickers against real market data
// Logic: swing20 (within 8%) > MA (if closer than swing90) > swing90 > Fib > pivot
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

function nearestLevel(candidates, price, direction, minPct = 0.003) {
  const side = direction === 'above'
  return candidates
    .filter(c => side ? c.price > price * (1 + minPct) : c.price < price * (1 - minPct))
    .sort((a, b) => side ? a.price - b.price : b.price - a.price)[0] || null
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

  const { levels: fibs, swingHigh, swingLow } = computeFibs(allDays, 90)

  // Swing detection: 20-day (sensitive) and 90-day (structural)
  const { highs: h90, lows: l90 } = findSwings(allDays.slice(-90), 3)
  const { highs: h20, lows: l20 } = findSwings(allDays.slice(-20), 2)

  const resist90  = clusterLevels(h90.filter(h => h.price > price))
  const support90 = clusterLevels(l90.filter(l => l.price < price))
  const resist20  = clusterLevels(h20.filter(h => h.price > price))
  const support20 = clusterLevels(l20.filter(l => l.price < price))

  const maBelow = [ma50, ma200].filter(m => m && m < price * 0.997).sort((a, b) => b - a)
  const maAbove = [ma50, ma200].filter(m => m && m > price * 1.003).sort((a, b) => a - b)

  // Fibs — skip 50% if within 1.5% of current price (prevents "S1 = current price" bug)
  const fibsBelow = fibs.filter(f =>
    f.price < price * 0.997 &&
    !(f.ratio === 0.500 && Math.abs(f.price - price) / price < 0.015)
  )
  const fibsAbove = fibs.filter(f =>
    f.price > price * 1.003 &&
    !(f.ratio === 0.500 && Math.abs(f.price - price) / price < 0.015)
  )

  const r1_s20 = nearestLevel(resist20,  price, 'above', 0.003)
  const r1_s90 = nearestLevel(resist90,  price, 'above', 0.003)
  const s1_s20 = nearestLevel(support20, price, 'below', 0.003)
  const s1_s90 = nearestLevel(support90, price, 'below', 0.003)

  const distFromPrice = (v, dir) =>
    dir === 'above' ? (v - price) / price : (price - v) / price

  // ── S1: best support below price ──────────────────────────────────────────
  // Priority: swing20 within 8% > MA (when closer than swing90) > swing90 within 8% > MA > Fib
  let s1, s1src
  const s20d = s1_s20 ? distFromPrice(s1_s20.price, 'below') : 999
  const s90d = s1_s90 ? distFromPrice(s1_s90.price, 'below') : 999
  const mad  = maBelow[0] ? distFromPrice(maBelow[0], 'below') : 999

  if (s1_s20 && s20d < 0.08) {
    s1 = +s1_s20.price.toFixed(2); s1src = 'swing'
  } else if (maBelow[0] && mad < 0.08 && mad <= s90d) {
    // MA is within 8% AND closer than any 90d swing — MA wins (downtrend scenario)
    s1 = +maBelow[0].toFixed(2); s1src = 'MA'
  } else if (s1_s90 && s90d < 0.08) {
    s1 = +s1_s90.price.toFixed(2); s1src = 'swing'
  } else if (maBelow[0]) {
    s1 = +maBelow[0].toFixed(2); s1src = 'MA'
  } else {
    const fb = fibsBelow.sort((a, b) => b.price - a.price)[0]
    s1 = fb ? +fb.price.toFixed(2) : +pivots.s1.toFixed(2)
    s1src = fb ? fb.label : 'pivot'
  }

  // ── R1: best resistance above price ───────────────────────────────────────
  // Priority: swing20 within 8% > Fib (when closer than swing90) > swing90 > Fib > MA > pivot
  let r1, r1src
  const r20d  = r1_s20  ? distFromPrice(r1_s20.price, 'above') : 999
  const r90d  = r1_s90  ? distFromPrice(r1_s90.price, 'above') : 999
  const nearFib = fibsAbove.sort((a, b) => a.price - b.price)[0]
  const fibD  = nearFib ? distFromPrice(nearFib.price, 'above') : 999

  if (r1_s20 && r20d < 0.08) {
    r1 = +r1_s20.price.toFixed(2); r1src = 'swing'
  } else if (nearFib && fibD < 0.08 && (!r1_s90 || fibD <= r90d)) {
    // Fib within 8% and closer than distant 90d swing
    r1 = +nearFib.price.toFixed(2); r1src = nearFib.label
  } else if (r1_s90 && r90d < 0.08) {
    r1 = +r1_s90.price.toFixed(2); r1src = 'swing'
  } else if (nearFib) {
    r1 = +nearFib.price.toFixed(2); r1src = nearFib.label
  } else if (maAbove[0]) {
    r1 = +maAbove[0].toFixed(2); r1src = 'MA'
  } else {
    r1 = +pivots.r1.toFixed(2); r1src = 'pivot'
  }

  // ── S2/R2: next levels, capped at 15% from price ──────────────────────────
  const s2cands = [
    ...support90.filter(c => c.price < s1 * 0.995 && c.price > price * 0.85),
    ...fibsBelow.filter(f => f.price < s1 * 0.995 && f.price > price * 0.85)
      .map(f => ({ price: f.price, touches: 1 })),
  ]
  const r2cands = [
    ...resist90.filter(c => c.price > r1 * 1.005 && c.price < price * 1.15),
    ...fibsAbove.filter(f => f.price > r1 * 1.005 && f.price < price * 1.15)
      .map(f => ({ price: f.price, touches: 1 })),
  ]
  const s2res = nearestLevel(s2cands, s1, 'below', 0.005)
  const r2res = nearestLevel(r2cands, r1, 'above', 0.005)
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
    _version: 'v8-final',
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
