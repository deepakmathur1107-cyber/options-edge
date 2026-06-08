/**
 * api/alerts/send.js — Vercel Serverless Function (Cron)
 *
 * Cron: "0 14 * * 1-5"  (9 AM ET weekdays)
 * Manual: POST /api/alerts/send  with header  x-cron-secret: <CRON_SECRET>
 *
 * Supabase table: alert_prefs
 * Columns used: clerk_user_id, email_alerts, alert_email, min_edge_score,
 *               symbols (comma-separated text), sms_on, phone_number
 */

const { createClient } = require('@supabase/supabase-js')

const TRADIER_BASE  = 'https://api.tradier.com/v1'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'AMZN', 'META', 'IWM', 'AAPL']

// ── Twilio SMS ────────────────────────────────────────────────────────────
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from  = process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) {
    console.warn('SMS skipped: Twilio env vars not set')
    return false
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    }
  )
  if (!res.ok) { console.error('Twilio error:', await res.json().catch(() => ({}))); return false }
  return true
}

// ── Resend email ──────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL || 'alerts@optionsedgeflow.com',
      to, subject, html,
    }),
  })
  return res.ok
}

// ── Tradier options chain ─────────────────────────────────────────────────
async function fetchChain(symbol) {
  const expRes = await fetch(
    `${TRADIER_BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=true`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  )
  if (!expRes.ok) return []
  const expData = await expRes.json()
  const expirations = expData?.expirations?.date
  if (!expirations?.length) return []
  const expiry = Array.isArray(expirations) ? expirations[0] : expirations

  const chainRes = await fetch(
    `${TRADIER_BASE}/markets/options/chains?symbol=${symbol}&expiration=${expiry}&greeks=true`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  )
  if (!chainRes.ok) return []
  return (await chainRes.json())?.options?.option || []
}

// ── Edge scoring ──────────────────────────────────────────────────────────
function computeEdgeScore(c) {
  const delta  = Math.abs(c?.greeks?.delta  ?? 0)
  const iv     = c?.greeks?.smv_vol          ?? 0
  const oi     = c?.open_interest            ?? 0
  const volume = c?.volume                   ?? 0
  const bid    = c?.bid                      ?? 0
  const ask    = c?.ask                      ?? 0

  if (delta === 0 || iv === 0) {
    return Math.min(100, Math.round((Math.log1p(oi) * 5) + (Math.log1p(volume) * 10)))
  }
  const deltaScore  = delta >= 0.3 && delta <= 0.7 ? 30 : 10
  const ivScore     = iv >= 0.2 && iv <= 0.6 ? 25 : 10
  const liqScore    = Math.min(25, Math.round(Math.log1p(oi + volume) * 3))
  const spreadScore = (ask - bid) < 0.10 ? 20 : (ask - bid) < 0.25 ? 10 : 0
  return Math.min(100, deltaScore + ivScore + liqScore + spreadScore)
}

// ── Email HTML ────────────────────────────────────────────────────────────
function buildEmailHtml(alerts) {
  const rows = alerts.map(a => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1a2e3e;font-weight:700;color:#00ff88;font-family:monospace">${a.symbol}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1a2e3e;color:#c8d8e8;font-family:monospace">${a.type} ${a.strike} ${a.expiry}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1a2e3e;color:#00c8ff;font-family:monospace">${a.score}%</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1a2e3e;color:#c8d8e8;font-family:monospace">$${a.mid?.toFixed(2) ?? '—'}</td>
    </tr>`).join('')
  return `
    <div style="background:#090e14;color:#c8d8e8;font-family:Inter,sans-serif;padding:32px;max-width:600px;margin:0 auto">
      <h1 style="font-family:'Bebas Neue',sans-serif;color:#00ff88;letter-spacing:3px;margin-bottom:4px">OPTIONS EDGE ALERT</h1>
      <p style="color:#4a7a8a;font-size:12px;font-family:monospace;margin-top:0">${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET</p>
      <table style="width:100%;border-collapse:collapse;background:#0d1a26;border:1px solid #1a2e3e;border-radius:6px">
        <thead><tr style="background:#0d2030">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#4a7a8a;font-family:monospace">SYMBOL</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#4a7a8a;font-family:monospace">CONTRACT</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#4a7a8a;font-family:monospace">EDGE</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#4a7a8a;font-family:monospace">MID</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#4a7a8a;font-size:11px;font-family:monospace;margin-top:24px">
        Not financial advice.<br>
        <a href="https://optionsedgeflow.com/app/settings/alerts" style="color:#00c8ff">Manage alert preferences</a>
      </p>
    </div>`
}

// ── SMS text ──────────────────────────────────────────────────────────────
function buildSmsText(alerts) {
  const lines = alerts.slice(0, 3).map(a =>
    `${a.symbol} ${a.type} ${a.strike} ${a.expiry} — ${a.score}% edge @ $${a.mid?.toFixed(2) ?? '?'}`
  )
  return `OptionsEdge (${new Date().toLocaleDateString('en-US',{timeZone:'America/New_York'})}):\n${lines.join('\n')}\noptionsedgeflow.com/app`
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || (req.headers['authorization'] || '').replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' })

  const scannedAt = new Date().toISOString()

  try {
    // 1. Fetch users with email or SMS alerts on
    const { data: users, error: usersErr } = await supabase
      .from('alert_prefs')
      .select('*')
      .or('email_alerts.eq.true,sms_on.eq.true')

    if (usersErr) {
      console.error('Supabase fetch error:', usersErr)
      return res.status(500).json({ error: usersErr.message })
    }

    console.log(`Users with alerts enabled: ${users?.length ?? 0}`)
    if (!users?.length) {
      return res.status(200).json({ sent: 0, scannedAt, note: 'No users with alerts enabled' })
    }

    // 2. Collect all unique symbols
    const allSymbols = new Set(DEFAULT_SYMBOLS)
    for (const u of users) {
      if (u.symbols) u.symbols.split(',').map(s => s.trim()).filter(Boolean).forEach(s => allSymbols.add(s))
    }
    const symbols = [...allSymbols]
    console.log('Scanning:', symbols)

    // 3. Fetch chains and score
    const alertsBySymbol = {}
    for (const sym of symbols) {
      try {
        const chain = await fetchChain(sym)
        const scored = chain
          .map(c => ({
            symbol: sym,
            type:   c.option_type === 'call' ? 'CALL' : 'PUT',
            strike: c.strike,
            expiry: c.expiration_date,
            score:  computeEdgeScore(c),
            mid:    ((c.bid ?? 0) + (c.ask ?? 0)) / 2,
          }))
          .filter(c => c.score >= 40)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
        if (scored.length) alertsBySymbol[sym] = scored
      } catch (e) {
        console.error(`Chain failed for ${sym}:`, e.message)
      }
    }

    // 4. Notify each user
    let sent = 0
    for (const user of users) {
      const watchlist = user.symbols
        ? user.symbols.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_SYMBOLS
      const minScore = user.min_edge_score ?? 50

      const userAlerts = watchlist
        .flatMap(sym => alertsBySymbol[sym] || [])
        .filter(a => a.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)

      if (!userAlerts.length) { console.log(`No alerts for ${user.clerk_user_id}`); continue }

      let notified = false

      if (user.email_alerts && user.alert_email) {
        const ok = await sendEmail(
          user.alert_email,
          `OptionsEdge: ${userAlerts.length} high-conviction alert${userAlerts.length > 1 ? 's' : ''} today`,
          buildEmailHtml(userAlerts)
        )
        if (ok) { notified = true; console.log(`Email → ${user.alert_email}`) }
      }

      if (user.sms_on && user.phone_number) {
        const ok = await sendSms(user.phone_number, buildSmsText(userAlerts))
        if (ok) { notified = true; console.log(`SMS → ${user.phone_number}`) }
      }

      if (notified) sent++
    }

    return res.status(200).json({ sent, symbols, scannedAt })
  } catch (e) {
    console.error('alerts/send fatal:', e)
    return res.status(500).json({ error: e.message })
  }
}
