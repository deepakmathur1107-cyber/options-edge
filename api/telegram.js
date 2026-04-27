// api/telegram.js — Vercel serverless proxy for Telegram API
// Runs server-side so no CORS issues

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Vercel does NOT auto-parse JSON body — parse it manually if needed
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body) body = {};

  const { message, chat_id, token } = body;

  // Use env vars (set in Vercel dashboard) or fall back to values from request
  const botToken = process.env.TELEGRAM_BOT_TOKEN || token;
  const chatId   = process.env.TELEGRAM_CHAT_ID   || chat_id;

  if (!botToken || !chatId) {
    res.status(400).json({
      error: 'Missing bot token or chat ID. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Vercel env vars, or pass token and chat_id in request body.'
    });
    return;
  }

  if (!message) {
    res.status(400).json({ error: 'Missing message in request body' });
    return;
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
    });

    const data = await r.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
