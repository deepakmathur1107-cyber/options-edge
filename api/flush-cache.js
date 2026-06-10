/**
 * api/flush-cache.js
 * POST /api/flush-cache  (admin/cron secret required)
 * Flushes all Tradier price cache keys from Redis
 * DELETE THIS FILE after running once
 */
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const secret = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(200).json({ ok: true, message: 'No Redis configured — nothing to flush' })
  }

  try {
    // Get all keys matching our cache prefix
    const scanRes = await fetch(`${REDIS_URL}/keys/tr:*`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    })
    const scanData = await scanRes.json()
    const keys = scanData.result || []

    if (keys.length === 0) {
      return res.status(200).json({ ok: true, flushed: 0, message: 'No cache keys found' })
    }

    // Delete all matching keys
    const delRes = await fetch(`${REDIS_URL}/del/${keys.map(encodeURIComponent).join('/')}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    })
    const delData = await delRes.json()

    return res.status(200).json({
      ok:      true,
      flushed: keys.length,
      keys,
      result:  delData.result,
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
