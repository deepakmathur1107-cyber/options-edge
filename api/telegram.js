// api/telegram.js — Vercel serverless proxy for Telegram Bot API
// Auth: Clerk JWT (admin only) OR CRON_SECRET (for alert sends from cron)
// Bot token accepted from request body (admin's own bot) or TELEGRAM_BOT_TOKEN env var

const { getAuth, ADMIN_IDS } = require('./_lib/auth')

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret, Authorization')
  if (req.method === 'OPTIONS') { res.status(200).end(); return }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return }

  // ── Auth: accept CRON_SECRET (cron jobs) OR Clerk JWT (admin UI) ──────────
  const cronSecret = req.headers['x-cron-secret'] || ''
  const isCron = process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET

  if (!isCron) {
    const { clerkId } = await getAuth(req)
    if (!clerkId || !ADMIN_IDS.includes(clerkId)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  if (!body) body = {}

  const { message, token, chat_id } = body

  // Bot token: use body token (from admin UI) or fall back to env var
  const botToken = (token || '').trim() || process.env.TELEGRAM_BOT_TOKEN
  const chatId   = (chat_id || '').trim() || process.env.TELEGRAM_CHAT_ID

  if (!botToken) return res.status(400).json({ error: 'Bot token required — enter it in Settings or set TELEGRAM_BOT_TOKEN env var' })
  if (!chatId)   return res.status(400).json({ error: 'Chat ID required' })
  if (!message)  return res.status(400).json({ error: 'Missing message' })

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
