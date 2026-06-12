/**
 * api/alerts/trigger.js
 * Manual trigger — GET only (Vercel blocks POST via rewrites catch-all)
 * GET /api/alerts/trigger?secret=CRON_SECRET
 */
const sendHandler = require('./send')

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://optionsedgeflow.com')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // Accept secret from query param OR header
  // Security: accept secret via header only, never query param (would appear in logs)
  const secret = req.headers['x-cron-secret'] ||
    (req.headers['authorization'] || '').replace('Bearer ', '').trim()

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  return sendHandler(req, res)
}
