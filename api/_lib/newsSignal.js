// api/_lib/newsSignal.js
// Added 2026-07-20. Phase 2 (piece 2) of the re-architecture roadmap:
// SHADOW-ONLY per-ticker news presence signal for Quick, per the target
// design doc (Quick=market/news, Swing+=technical/fundamental).
//
// SHADOW MEANS SHADOW — same discipline as every other new signal this
// week: this is LOGGED, never scored. Two reasons, not one:
//   1. General policy — no new signal enters live scoring without a
//      log-first-then-validate period against real resolved outcomes (this
//      week's own 52w-bonus and momentum findings were each wrong or
//      backwards on first intuition).
//   2. Specific to this signal — it's PRESENCE/COUNT only, not sentiment.
//      Finnhub's company-news endpoint returns headlines, not a positive/
//      negative read. "Has 3 recent headlines" says nothing about whether
//      that's good or bad news. Turning this into a real DIRECTIONAL signal
//      (needed before it could ever be scored) is future work, explicitly
//      out of scope here — this piece only proves the data pipeline and
//      starts accumulating what a presence signal looks like against
//      outcomes.
//
// Endpoint verified against Finnhub's own documented examples before
// building against it (not assumed) — GET /company-news?symbol=X&from=...
// &to=...&token=...

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '' // same key newsData.js already uses
const REDIS_TTL_SECS = 2 * 60 * 60 // 2h — news needs to stay fresher than
                                    // fundamentals' 1h/7d pattern, but Quick
                                    // rescans every 15min and headlines don't
                                    // change that fast; balances freshness
                                    // against Finnhub's 60/min free-tier cap
                                    // across ~340 tickers/scan.

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

// getRecentNewsSignal(ticker) — LOG ONLY, see file header. Returns
// { count, headlines } where headlines is capped to 3 for spot-check
// purposes (not meant as a full feed). Never throws — a failed news fetch
// must never affect the live scan path that called it.
async function getRecentNewsSignal(ticker) {
  const redisKey = `news:${ticker}:live`
  const cached = await redisGet(redisKey)
  if (cached) return cached

  if (!FINNHUB_KEY) return { count: null, headlines: [] } // not configured — honest null, not a fabricated 0

  try {
    const end = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - 2) // last 2 days — recent enough to matter for a 5-14 day Quick hold
    const from = start.toISOString().slice(0, 10)
    const to = end.toISOString().slice(0, 10)

    const r = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!r.ok) {
      console.warn(`[newsSignal] ${ticker} Finnhub company-news failed: ${r.status}`)
      return { count: null, headlines: [] }
    }
    const data = await r.json()
    const items = Array.isArray(data) ? data : []
    const result = {
      count: items.length,
      headlines: items.slice(0, 3).map(n => ({ headline: n.headline, source: n.source, time: n.datetime })),
    }
    await redisSet(redisKey, result, REDIS_TTL_SECS)
    return result
  } catch (e) {
    console.warn(`[newsSignal] ${ticker} fetch failed:`, e.message)
    return { count: null, headlines: [] }
  }
}

module.exports = { getRecentNewsSignal }
