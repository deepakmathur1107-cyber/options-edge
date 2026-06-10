/**
 * api/test-email.js
 * POST /api/test-email  — sends a test email via Resend to verify config
 * DELETE THIS FILE after testing
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const secret = (req.headers['x-cron-secret'] || '').trim()
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' })

  const to   = req.query.to || 'test@example.com'
  const from = process.env.ALERT_FROM_EMAIL || 'alerts@optionsedgeflow.com'
  const key  = process.env.RESEND_API_KEY   || ''

  // 1. Check env vars are set
  const envCheck = {
    RESEND_API_KEY:    key ? key.slice(0,8)+'...' : '❌ NOT SET',
    ALERT_FROM_EMAIL:  from,
    sending_to:        to,
  }

  if (!key) return res.status(500).json({ error: 'RESEND_API_KEY not set', envCheck })

  // 2. Try sending
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'OptionsEdge — Test Email',
      html: '<p style="font-family:sans-serif">Test email from OptionsEdge. If you see this, Resend is working correctly.</p>',
    }),
  })

  const data = await r.json().catch(() => ({}))

  return res.status(200).json({
    http_status: r.status,
    resend_ok:   r.ok,
    resend_response: data,
    envCheck,
  })
}
