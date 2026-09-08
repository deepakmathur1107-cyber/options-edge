// api/_lib/trendContext.js
// Long-term trend context — added 2026-07-18 following the win-rate deep dive.
//
// WHY THIS EXISTS: analysis of resolved Swing puts (n=463, real sample) showed
// a clean natural-experiment signature — the SAME entry cohort (June 22/29)
// won 34-36% at Quick's 5-14 day hold but only 18-24% at Swing's 21-45 day
// hold. That's consistent with short-term-correct bearish calls getting
// overrun by a longer-term bullish grind the longer they're held — NOT
// necessarily a scoring bug. The existing spxChgToday/ndxChgToday fields only
// capture TODAY's single-day move; nothing in the codebase before this
// measured the multi-week/multi-month trend a position's duration is being
// held into. This module adds that.
//
// DELIBERATE SCOPE LIMIT: only the long-term trend classification feeds into
// scoring (as a dampener on counter-trend Swing/LEAP/Deep LEAP setups — see
// convictionScore.cjs). VIX is fetched and LOGGED ONLY, not scored. Per this
// week's own hard-won lesson (the 52w-proximity bonus and momentum term were
// each wrong in ways that weren't obvious until checked against real resolved
// outcomes), no new signal should be wired into live scoring on intuition
// alone. VIX needs its own log-first-then-validate period before it earns a
// place in the formula.
//
// CommonJS only — lives in _lib, does NOT count as a Vercel function.

const { calculateDmiVolumeConfirmation } = require('./dmiVolumeConfirmation')

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''
const REDIS_TTL_SECS = 20 * 60 * 60   // 20h — trend is a daily-close concept,
                                       // no need to refresh more than once/day;
                                       // set just under 24h so it naturally
                                       // rolls to a fresh value each trading day

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    })
    const d = await r.json()
    if (!d.result) return null
    const parsed = typeof d.result === 'string' ? JSON.parse(d.result) : d.result
    if (parsed && typeof parsed === 'object' && 'value' in parsed && 'ex' in parsed) {
      return typeof parsed.value === 'string' ? JSON.parse(parsed.value) : parsed.value
    }
    return parsed
  } catch { return null }
}

async function redisSet(key, value, ttl) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttl]]),
    })
  } catch {}
}

function sma(closes, n) {
  if (closes.length < n) return null
  const slice = closes.slice(-n)
  return slice.reduce((a, b) => a + b, 0) / n
}

// Classifies long-term trend from daily closes. Uses the classic 50/200 SMA
// relationship rather than a single lookback window, since it's the standard,
// well-understood definition (avoids inventing a bespoke threshold that's
// really just curve-fit to this one geopolitically unusual quarter).
//   bullish: price > SMA50 > SMA200  (or price > SMA200 if <200 days of history)
//   bearish: price < SMA50 < SMA200  (mirrored)
//   mixed:   anything else (choppy/transitioning — deliberately NOT treated as
//            confidently trending in either direction)
function classifyTrend(closes, lastPrice) {
  const sma50  = sma(closes, 50)
  const sma200 = sma(closes, 200)
  if (sma50 == null) return { direction: 'unknown', sma50: null, sma200: null }
  if (sma200 == null) {
    // Under 200 days of history (recent listing) — fall back to a simpler
    // price-vs-SMA50 read rather than block-and-treat-as-mixed forever.
    const direction = lastPrice > sma50 ? 'bullish' : lastPrice < sma50 ? 'bearish' : 'mixed'
    return { direction, sma50, sma200: null }
  }
  let direction = 'mixed'
  if (lastPrice > sma50 && sma50 > sma200) direction = 'bullish'
  else if (lastPrice < sma50 && sma50 < sma200) direction = 'bearish'
  return { direction, sma50, sma200 }
}

function classifyWeeklyTrend(bars) {
  if (!Array.isArray(bars) || bars.length < 50) return { direction: 'unknown', sma10: null, sma40: null }
  const weeks = new Map()
  for (const bar of bars) {
    const date = new Date(`${bar.date}T12:00:00Z`)
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(Number(bar.close))) continue
    const day = date.getUTCDay() || 7
    date.setUTCDate(date.getUTCDate() + (4 - day))
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
    weeks.set(`${date.getUTCFullYear()}-${week}`, Number(bar.close))
  }
  const closes = [...weeks.values()]
  const lastPrice = closes.at(-1)
  const sma10 = sma(closes, 10)
  const sma40 = sma(closes, 40)
  if (!Number.isFinite(lastPrice) || sma10 == null) return { direction: 'unknown', sma10, sma40 }
  let direction = 'mixed'
  if (sma40 == null) direction = lastPrice > sma10 ? 'bullish' : lastPrice < sma10 ? 'bearish' : 'mixed'
  else if (lastPrice > sma10 && sma10 > sma40) direction = 'bullish'
  else if (lastPrice < sma10 && sma10 < sma40) direction = 'bearish'
  return { direction, sma10, sma40 }
}

// getTrendContext(ticker, asOfDate, historyFetcher, rateTracker)
// asOfDate: 'YYYY-MM-DD' string, or omit for "today" (live scans always omit;
// the backtest endpoint passes historical dates to reconstruct trend AS OF
// each trade's actual entry date, not today's trend).
// historyFetcher: (symbol, startDate, endDate, tracker) => Promise<bars[]>,
// where each bar has a numeric .close — matches BOTH scan.js's local getHistory
// and tradierClient.js's getOptionHistory (which, despite the name, hits the
// generic /markets/history endpoint and works for any symbol, not just
// options — confirmed earlier this week when reused for underlying-price
// capture in the resolver). Passed in rather than required directly so this
// module doesn't need to know which of the two near-duplicate Tradier
// wrappers the caller has.
async function getTrendContext(ticker, asOfDate, historyFetcher, rateTracker) {
  const dateKey = asOfDate || 'live'
  const redisKey = `trend:${ticker}:${dateKey}`
  if (!asOfDate) {
    // Only cache "live" (today's) lookups — backtest lookups hit many
    // distinct historical dates per ticker and would just cold-miss anyway,
    // no benefit to caching those, and it'd pollute Redis with one-off keys.
    const cached = await redisGet(redisKey)
    if (cached) return cached
  }

  const end = asOfDate ? new Date(asOfDate + 'T12:00:00') : new Date()
  const endStr = end.toISOString().slice(0, 10)
  const start = new Date(end)
  start.setDate(start.getDate() - 340)  // ~340 calendar days ≈ 230+ trading days, comfortable margin over 200
  const startStr = start.toISOString().slice(0, 10)

  try {
    const bars = await historyFetcher(ticker, startStr, endStr, rateTracker)
    if (!bars || !bars.length) return { direction: 'unknown', sma50: null, sma200: null }
    const closes = bars.map(b => b.close).filter(c => typeof c === 'number' && !isNaN(c))
    const lastPrice = closes[closes.length - 1]
    const result = {
      ...classifyTrend(closes, lastPrice),
      weekly_trend: classifyWeeklyTrend(bars),
      dmi_volume_confirmation: calculateDmiVolumeConfirmation(bars),
    }
    if (!asOfDate) await redisSet(redisKey, result, REDIS_TTL_SECS)
    return result
  } catch (e) {
    console.warn(`[trendContext] ${ticker} trend fetch failed:`, e.message)
    return { direction: 'unknown', sma50: null, sma200: null }
  }
}

// getVix(quoteFetcher, rateTracker) — LOG ONLY, see scope note at top of file.
// quoteFetcher: (symbol, tracker) => Promise<quote|null>, matches both scan.js's
// local getQuote and tradierClient.js's getQuote.
async function getVix(quoteFetcher, rateTracker) {
  const redisKey = 'vix:live'
  const cached = await redisGet(redisKey)
  if (cached) return cached
  try {
    const quote = await quoteFetcher('VIX', rateTracker)
    if (!quote) return { level: null, chgPct: null }
    const level = parseFloat(quote.last || quote.prevclose || 0) || null
    const prevClose = parseFloat(quote.prevclose || 0) || null
    const chgPct = (level && prevClose) ? ((level - prevClose) / prevClose) * 100 : null
    const result = { level, chgPct }
    await redisSet(redisKey, result, 15 * 60) // 15min — VIX moves intraday, unlike daily-close trend
    return result
  } catch (e) {
    console.warn('[trendContext] VIX fetch failed:', e.message)
    return { level: null, chgPct: null }
  }
}

module.exports = { getTrendContext, getVix, classifyTrend, classifyWeeklyTrend, sma }
