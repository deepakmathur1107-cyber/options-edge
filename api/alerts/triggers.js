/**
 * api/alerts/trigger.js
 * Manual trigger endpoint — not a cron, accepts POST
 * POST /api/alerts/trigger  with x-cron-secret header
 * Calls the same logic as send.js
 */
const sendHandler = require('./send')

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-cron-secret')
  if (req.method === 'OPTIONS') return res.status(204).end()
  // Delegate entirely to send handler
  return sendHandler(req, res)
}
