// api/_lib/srLevels.js
// v9-final — handles all market scenarios correctly:
// Uptrend: MAs = support, swing lows = S1
// Downtrend: MAs above price = resistance (R1/R2), Fib extensions = S1
// Range: swing levels dominate
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

function nearest(candidates, price, direction, minPct = 0.003) {
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

  // Swing detection
  const { highs: h90, lows: l90 } = findSwings(allDays.slice(-90), 3)
  const { highs: h20, lows: l20 } = findSwings(allDays.slice(-20), 2)

  const resist90  = clusterLevels(h90.filter(h => h.price > price))
  const support90 = clusterLevels(l90.filter(l => l.price < price))
  const resist20  = clusterLevels(h20.filter(h => h.price > price))
  const support20 = clusterLevels(l20.filter(l => l.price < price))

  // Determine if MAs are above or below price
  const ma50above  = ma50  && ma50  > price
  const ma200above = ma200 && ma200 > price
  const bothMAsAbove = ma50above && ma200above  // stock below both MAs = downtrend

  // Categorize MAs
  const maResist = [ma50, ma200].filter(m => m && m > price * 1.003).sort((a, b) => a - b)
  const maSupport= [ma50, ma200].filter(m => m && m < price * 0.997).sort((a, b) => b - a)

  // Fibs — skip 50% if within 1.5% of price
  const fibsBelow = fibs.filter(f =>
    f.price < price * 0.997 &&
    !(f.ratio === 0.500 && Math.abs(f.price - price) / price < 0.015)
  )
  const fibsAbove = fibs.filter(f =>
    f.price > price * 1.003 &&
    !(f.ratio === 0.500 && Math.abs(f.price - price) / price < 0.015)
  )

  const dist = (v, dir) => dir === 'above' ? (v - price) / price : (price - v) / price

  // ── S1 ─────────────────────────────────────────────────────────────────────
  let s1, s1src

  const sw20 = nearest(support20, price, 'below', 0.003)
  const sw90 = nearest(support90, price, 'below', 0.003)
  const maS  = maSupport[0]
  const fibS = fibsBelow.sort((a, b) => b.price - a.price)[0]

  if (sw20 && dist(sw20.price, 'below') < 0.08) {
    // Recent swing low within 8% — most reliable
    s1 = +sw20.price.toFixed(2); s1src = 'swing'
  } else if (!bothMAsAbove && maS && dist(maS, 'below') < 0.08) {
    // MA below price (uptrend) — use as support
    s1 = +maS.toFixed(2); s1src = 'MA'
  } else if (sw90 && dist(sw90.price, 'below') < 0.08) {
    // 90d swing within 8%
    s1 = +sw90.price.toFixed(2); s1src = 'swing'
  } else if (bothMAsAbove) {
    // Both MAs above price (downtrend) — use recent day low or Fib below
    const recentLow = Math.min(...allDays.slice(-5).map(d => d.low))
    if ((price - recentLow) / price < 0.05) {
      s1 = +recentLow.toFixed(2); s1src = 'recent low'
    } else if (fibS) {
      s1 = +fibS.price.toFixed(2); s1src = fibS.label
    } else {
      s1 = +pivots.s1.toFixed(2); s1src = 'pivot'
    }
  } else if (maS) {
    s1 = +maS.toFixed(2); s1src = 'MA'
  } else if (fibS) {
    s1 = +fibS.price.toFixed(2); s1src = fibS.label
  } else {
    s1 = +pivots.s1.toFixed(2); s1src = 'pivot'
  }

  // ── R1 ─────────────────────────────────────────────────────────────────────
  let r1, r1src

  const rw20  = nearest(resist20,  price, 'above', 0.003)
  const rw90  = nearest(resist90,  price, 'above', 0.003)
  const maR   = maResist[0]
  const fibR  = fibsAbove.sort((a, b) => a.price - b.price)[0]

  if (rw20 && dist(rw20.price, 'above') < 0.08) {
    r1 = +rw20.price.toFixed(2); r1src = 'swing'
  } else if (bothMAsAbove && maR && dist(maR, 'above') < 0.08) {
    // Both MAs above in downtrend — nearest MA is immediate resistance
    r1 = +maR.toFixed(2); r1src = 'MA'
  } else if (fibR && dist(fibR.price, 'above') < 0.08 && (!rw90 || dist(fibR.price,'above') <= dist(rw90.price,'above'))) {
    r1 = +fibR.price.toFixed(2); r1src = fibR.label
  } else if (rw90 && dist(rw90.price, 'above') < 0.08) {
    r1 = +rw90.price.toFixed(2); r1src = 'swing'
  } else if (maR) {
    r1 = +maR.toFixed(2); r1src = 'MA'
  } else if (fibR) {
    r1 = +fibR.price.toFixed(2); r1src = fibR.label
  } else {
    r1 = +pivots.r1.toFixed(2); r1src = 'pivot'
  }

  // ── S2/R2 capped at 15% ────────────────────────────────────────────────────
  const s2cands = [
    ...support90.filter(c => c.price < s1 * 0.995 && c.price > price * 0.85),
    ...fibsBelow.filter(f => f.price < s1 * 0.995 && f.price > price * 0.85).map(f => ({ price: f.price, touches: 1 })),
  ]
  const r2cands = [
    ...resist90.filter(c => c.price > r1 * 1.005 && c.price < price * 1.15),
    ...fibsAbove.filter(f => f.price > r1 * 1.005 && f.price < price * 1.15).map(f => ({ price: f.price, touches: 1 })),
    ...maResist.filter(m => m > r1 * 1.005 && m < price * 1.15).map(m => ({ price: m, touches: 1 })),
  ]
  const s2res = nearest(s2cands, s1, 'below', 0.005)
  const r2res = nearest(r2cands, r1, 'above', 0.005)
  const s2 = s2res ? +s2res.price.toFixed(2) : +(Math.max(Math.min(pivots.s2, s1 * 0.97), price * 0.85)).toFixed(2)
  const r2 = r2res ? +r2res.price.toFixed(2) : +(Math.min(Math.max(pivots.r2, r1 * 1.03), price * 1.15)).toFixed(2)

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
    _version: 'v9-final',
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
