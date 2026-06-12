// api/telegram.js — Vercel serverless proxy for Telegram API
// Admin-only: requires valid CRON_SECRET header.
// Runs server-side so no CORS issues and bot token stays server-side only.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret, Authorization')
  if (req.method === 'OPTIONS') { res.status(200).end(); return }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return }

  // ── Auth: require CRON_SECRET (admin-only endpoint) ───────────────────────
  const secret = req.headers['x-cron-secret'] ||
    (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // Parse body
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { body = {} }
  }
  if (!body) body = {}

  const { message, chat_id } = body

  // Bot token and chat ID must come from server env vars — never from request body
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId   = process.env.TELEGRAM_CHAT_ID || chat_id

  if (!botToken) {
    res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured in Vercel env vars' })
    return
  }
  if (!chatId) {
    res.status(400).json({ error: 'Missing chat_id (or set TELEGRAM_CHAT_ID in env vars)' })
    return
  }
  if (!message) {
    res.status(400).json({ error: 'Missing message in request body' })
    return
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  chatId,
        text:                     message,
        parse_mode:               'Markdown',
        disable_web_page_preview: true,
      }),
    })

    const data = await r.json()
    res.status(r.ok ? 200 : 502).json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
