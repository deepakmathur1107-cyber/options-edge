// api/_lib/rateLimit.js
// Simple fixed-window rate limiter backed by the Upstash Redis instance
// already used elsewhere (tradier.js caching). No new infra, no new env vars.
//
// Usage in a handler:
//   const { allowed, remaining, resetIn } = await rateLimit(`feedback:${clerkId||ip}`, 5, 60)
//   if (!allowed) return res.status(429).json({ error: 'Too many requests, try again shortly.' })
//
// This is a fixed-window limiter (not sliding), which is intentionally
// simple — it can allow up to 2x the limit right at a window boundary in
// the worst case, but that's an acceptable tradeoff for "stop obvious
// spam/abuse," not a rigorous quota system.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

async function rateLimit(key, maxRequests, windowSeconds) {
  // If Redis isn't configured for some reason, fail open (allow the
  // request) rather than break the feature entirely — rate limiting is
  // a hardening layer, not the primary access control.
  if (!REDIS_URL || !REDIS_TOKEN) {
    return { allowed: true, remaining: maxRequests, resetIn: windowSeconds, degraded: true }
  }

  const safeKey = `rl:${key}`.replace(/[^\w:.-]/g, '_').slice(0, 200)

  try {
    const incrRes = await fetch(`${REDIS_URL}/incr/${encodeURIComponent(safeKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    })
    const incrData = await incrRes.json()
    const count = incrData.result || 0

    // First request in this window — set the TTL so the counter resets.
    if (count === 1) {
      await fetch(`${REDIS_URL}/expire/${encodeURIComponent(safeKey)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: safeKey, seconds: windowSeconds }),
      })
    }

    const allowed   = count <= maxRequests
    const remaining = Math.max(0, maxRequests - count)
    return { allowed, remaining, resetIn: windowSeconds }

  } catch (e) {
    // Redis hiccup — fail open, same reasoning as the "not configured" case.
    console.error('[rateLimit] error, failing open:', e.message)
    return { allowed: true, remaining: maxRequests, resetIn: windowSeconds, degraded: true }
  }
}

// Pulls a best-effort client identifier when there's no clerkId (e.g.
// anonymous feedback submissions) — Vercel sets x-forwarded-for / x-real-ip.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers['x-real-ip'] || 'unknown'
}

module.exports = { rateLimit, clientIp }
