/**
 * api/alerts/send.js — Vercel Serverless Function (Cron + Manual trigger)
 *
 * Cron: "0 14 * * 1-5" (14:00 UTC) — this is 10 AM ET during EDT (summer)
 * or 9 AM ET during EST (winter). The UTC schedule itself never changes
 * and never needs touching across a DST flip; this comment is what used
 * to silently go stale twice a year by stating a single fixed ET time
 * without noting it only held for half the year — same class of bug
 * fixed in App.jsx/MorningBrief.jsx's timestamp displays (2026-06-29).
 * Manual: GET /api/alerts/send  (trigger.js has been deleted — this file handles both)
 *
 * vercel.json cron path must be /api/alerts/send
 *
 * REWRITE (2026-07-13): this file used to run its own separate, simpler
 * scoring engine (scoreContract) with its own Tradier calls, its own
 * 8-ticker hardcoded universe (DEFAULT_SYMBOLS), and its own DTE/direction
 * logic — completely disconnected from the main scanning engine
 * (convictionScore.cjs/scanLogic.js) that the rest of the app (Scan tab,
 * signal_history, every fix validated this session) relies on. That meant
 * none of this session's hardening — direction-aware scoring, gap-stacking
 * dampening, hysteresis, regime awareness, the average-volume liquidity
 * floor, the opening-window warning — applied to what actually got sent
 * to a user's phone or inbox. Per explicit product decision: ONE engine
 * finds trades; every outbound channel (email/SMS/Telegram) reads from
 * that same source rather than running parallel logic. This file no
 * longer scores anything or calls Tradier directly — it queries
 * scan_results (the same live cache /api/scan-cache reads) and formats
 * whatever the main engine already found for delivery.
 */

const { createClient } = require('@supabase/supabase-js')
const { decryptSecret } = require('../_lib/secretCrypto')
const { isOpeningWindow } = require('../_lib/scanLogic')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// getClerkEmail — fallback for users who enabled email_alerts but never
// typed an alert_email into Alert Settings. Clerk already has an email on
// file for every account (you can't sign up without one) — this fetches
// the user's PRIMARY email via Clerk's Backend API rather than asking them
// to re-enter something Clerk already knows, per product decision
// (2026-06-28): "if left empty on manual then use from Clerk."
// Uses CLERK_SECRET_KEY, same credential auth.js already uses for JWKS —
// no new secret needed. Returns null (not throws) on any failure, so a
// Clerk hiccup degrades to "skip this user's email this run," same fail-
// soft posture every other external call in this file already has
// (sendTg/sendSms/sendEmail all swallow and continue rather than
// aborting the whole run for one user's failure).
async function getClerkEmail(clerkUserId) {
  const key = process.env.CLERK_SECRET_KEY
  if (!key) return null
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!r.ok) return null
    const user = await r.json()
    // primary_email_address_id points into email_addresses[] — same shape
    // documented in Clerk's Backend API user object. Fall back to the
    // first verified address if primary_email_address_id is somehow unset
    // (seen in Clerk's own docs as a possible state for accounts created
    // via certain OAuth flows).
    const addrs = user?.email_addresses || []
    const primary = addrs.find(a => a.id === user.primary_email_address_id)
      || addrs.find(a => a.verification?.status === 'verified')
      || addrs[0]
    return primary?.email_address || null
  } catch (e) {
    console.error(`[getClerkEmail] failed for ${clerkUserId}:`, e.message)
    return null
  }
}

function parseSymbols(raw) {
  if (!raw) return []
  const s = typeof raw === 'string' ? raw.trim() : String(raw)
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      return Array.isArray(arr)
        ? arr.map(x => String(x).replace(/['"]/g, '').trim().toUpperCase()).filter(Boolean)
        : []
    } catch {}
  }
  return s.split(',').map(x => x.replace(/['"\[\]]/g, '').trim().toUpperCase()).filter(Boolean)
}

function gradeColor(grade) {
  if (grade === 'A') return '#00ff88'
  if (grade === 'B') return '#00c8ff'
  return '#ff9500'
}

// The main engine already writes a human-readable reason list per signal
// (r.reasons in scanLogic.js) — reuse the top one or two rather than
// re-deriving a summary from raw fields the way the old scoreContract
// path did. Keeps this file from re-implementing "why is this a good
// setup" logic a second time.
function topReasons(row, n = 2) {
  const reasons = Array.isArray(row.reasons) ? row.reasons : []
  return reasons.slice(0, n).join(' · ') || 'see full breakdown in-app'
}

// Single source of truth for "what did the engine find, right now" — the
// exact same scan_results rows /api/scan-cache serves to the Scan tab.
// Non-expired only (expires_at is already written by the scan cron as a
// ~20 min TTL per row); this file adds no scoring, no filtering beyond
// what the engine itself already decided, other than per-user preference
// narrowing applied later in the handler.
async function fetchCurrentSignals() {
  const { data, error } = await supabase
    .from('scan_results')
    .select('*')
    .gt('expires_at', new Date().toISOString())
    .order('score', { ascending: false })
  if (error) {
    console.error('[alerts/send] fetchCurrentSignals failed:', error.message)
    return []
  }
  return data || []
}

// Market bias banner (BULLISH/BEARISH/NEUTRAL) — reuses the same
// regime_spx_chg_pct/regime_ndx_chg_pct already computed once per scan run
// and stored on signal_history, instead of this file making its own
// separate SPY/QQQ Tradier calls the way the old version did. One fetch,
// not two extra live calls on top of what the scanner already did.
async function fetchMarketBias() {
  const { data, error } = await supabase
    .from('signal_history')
    .select('regime_spx_chg_pct, regime_ndx_chg_pct, scanned_at')
    .not('regime_spx_chg_pct', 'is', null)
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return { spx: null, ndx: null, bias: 'NEUTRAL', biasColor: '#ff9500' }
  const spx = data.regime_spx_chg_pct
  const bias = spx > 0.5 ? 'BULLISH' : spx < -0.5 ? 'BEARISH' : 'NEUTRAL'
  return {
    spx, ndx: data.regime_ndx_chg_pct, bias,
    biasColor: bias === 'BULLISH' ? '#00ff88' : bias === 'BEARISH' ? '#ff4466' : '#ff9500',
  }
}

function buildEmailHtml(alerts, marketCtx, openingWindow) {
  const dateStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const ctxHtml = marketCtx ? `
    <div style="background:#0d2030;border:1px solid #1a2e3e;border-radius:6px;padding:12px 16px;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap">
      ${marketCtx.spx != null ? `<span style="font-family:monospace;font-size:11px;color:#c8d8e8"><span style="color:#4a7a8a">SPX</span> <span style="color:${marketCtx.spx>=0?'#00ff88':'#ff4466'}">${marketCtx.spx>=0?'+':''}${marketCtx.spx.toFixed(2)}%</span></span>` : ''}
      ${marketCtx.ndx != null ? `<span style="font-family:monospace;font-size:11px;color:#c8d8e8"><span style="color:#4a7a8a">NDX</span> <span style="color:${marketCtx.ndx>=0?'#00ff88':'#ff4466'}">${marketCtx.ndx>=0?'+':''}${marketCtx.ndx.toFixed(2)}%</span></span>` : ''}
      <span style="font-family:monospace;font-size:11px;color:#c8d8e8"><span style="color:#4a7a8a">BIAS</span> <span style="color:${marketCtx.biasColor}">${marketCtx.bias}</span></span>
    </div>` : ''
  const warnHtml = openingWindow ? `
    <div style="background:#3a2200;border:1px solid #cc8400;border-radius:6px;padding:10px 16px;margin-bottom:16px">
      <span style="font-family:monospace;font-size:11px;color:#ffcc66">⚠ Sent during the first 30 min of trading — spreads are wider and scores can shift once volume/liquidity data settles. Consider waiting for confirmation before entering.</span>
    </div>` : ''

  const rows = alerts.map(row => {
    const reason = topReasons(row)
    return `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top">
        <div style="font-weight:700;color:#00ff88;font-family:monospace;font-size:13px">${row.ticker}</div>
        <div style="font-size:10px;color:#4a7a8a;margin-top:2px">@ $${Number(row.underlying_price ?? 0).toFixed(2)}</div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top">
        <div style="color:#c8d8e8;font-family:monospace;font-size:12px;font-weight:600">${row.trade_type} ${row.strike_str}</div>
        <div style="color:#4a7a8a;font-size:10px;margin-top:2px">${row.dte} DTE · ${row.timeframe}</div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top;text-align:center">
        <div style="display:inline-block;background:${gradeColor(row.grade)}22;border:1px solid ${gradeColor(row.grade)}55;border-radius:4px;padding:3px 10px">
          <span style="font-family:monospace;font-weight:700;font-size:15px;color:${gradeColor(row.grade)}">${row.grade}</span>
        </div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top">
        <div style="color:#c8d8e8;font-family:monospace;font-size:12px;font-weight:600">${row.mid}</div>
        <div style="font-size:10px;color:#4a7a8a;margin-top:2px">Stop ${row.stop || '—'} · Target ${row.target || '—'}</div>
      </td>
    </tr>
    <tr>
      <td colspan="4" style="padding:4px 12px 12px;border-bottom:1px solid #1a2e3e">
        <div style="font-size:10px;color:#4a7a8a;font-style:italic">${row.breakeven ? `Break-even: $${row.breakeven} · ` : ''}${reason}</div>
      </td>
    </tr>`
  }).join('')

  return `
  <div style="background:#090e14;color:#c8d8e8;font-family:Inter,Arial,sans-serif;padding:28px 24px;max-width:620px;margin:0 auto">
    <div style="margin-bottom:20px">
      <h1 style="font-family:'Bebas Neue',Impact,sans-serif;color:#00ff88;letter-spacing:3px;margin:0 0 4px 0;font-size:28px">OPTIONS EDGE ALERT</h1>
      <p style="color:#4a7a8a;font-size:11px;font-family:monospace;margin:0">${dateStr} ET · ${alerts.length} setup${alerts.length>1?'s':''} found</p>
    </div>
    ${warnHtml}
    ${ctxHtml}
    <table style="width:100%;border-collapse:collapse;background:#0d1a26;border:1px solid #1a2e3e;border-radius:6px;overflow:hidden">
      <thead>
        <tr style="background:#0a1520">
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">SYMBOL</th>
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">CONTRACT</th>
          <th style="padding:10px 12px;text-align:center;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">GRADE</th>
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">PREMIUM</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:20px;padding:12px 16px;background:#0d1a26;border:1px solid #1a2e3e;border-radius:6px">
      <div style="font-size:10px;color:#4a7a8a;font-family:monospace;line-height:1.8">
        <strong style="color:#c8d8e8">Grade guide:</strong>
        <span style="color:#00ff88;margin-left:8px">A = strong setup</span>
        <span style="color:#00c8ff;margin-left:8px">B = good setup</span>
        <span style="color:#ff9500;margin-left:8px">C = borderline</span><br>
        Stop/target shown per-trade — timeframe-specific, not a fixed percentage. Not financial advice.
      </div>
    </div>
    <p style="color:#2a4a5a;font-size:10px;font-family:monospace;margin-top:16px;text-align:center">
      <a href="https://optionsedgeflow.com/app" style="color:#00c8ff;text-decoration:none">Manage preferences at OptionsEdgeFlow</a>
      &nbsp;·&nbsp; You're receiving this because you enabled email alerts.
    </p>
  </div>`
}

function buildSmsText(alerts, marketCtx, openingWindow) {
  const bias  = marketCtx ? ` · ${marketCtx.bias}` : ''
  const warn  = openingWindow ? '\n⚠ First 30min — scores may shift' : ''
  const lines = alerts.slice(0, 3).map(row =>
    `[${row.grade}] ${row.ticker} ${row.trade_type} ${row.strike_str} (${row.dte}DTE) ${row.mid}`
  )
  return `OptionsEdge${bias}${warn}\n${lines.join('\n')}\noptionsedgeflow.com/app`
}

function buildTgText(alerts, marketCtx, openingWindow) {
  const bias  = marketCtx ? ` · ${marketCtx.bias}` : ''
  const warn  = openingWindow ? '\n⚠ _Sent during the first 30 min of trading — scores may shift as volume/liquidity data settles._' : ''
  const lines = alerts.slice(0, 5).map(row => {
    const dir = row.trade_type?.includes('Call') ? '📈' : '📉'
    return `${dir} *${row.ticker}* ${row.trade_type} ${row.strike_str} · ${row.score}% · ${row.mid} · ${row.dte}DTE`
  })
  return `*OptionsEdge Alerts*${bias}${warn}\n\n${lines.join('\n')}\n\noptionsedgeflow.com/app`
}

async function sendTg(botToken, chatId, text) {
  if (!botToken || !chatId) { console.warn('TG skipped: missing token or chat_id'); return false }
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    })
    const d = await r.json()
    if (!r.ok) { console.error('TG error:', JSON.stringify(d)); return false }
    return true
  } catch (e) { console.error('TG fetch error:', e.message); return false }
}

async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from  = process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) { console.warn('SMS skipped: Twilio env vars not set'); return false }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  })
  if (!res.ok) { console.error('Twilio error:', await res.json().catch(() => ({}))); return false }
  return true
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.ALERT_FROM_EMAIL || 'alerts@optionsedgeflow.com', to, subject, html }),
  })
  if (!res.ok) { console.error('Resend error:', JSON.stringify(await res.json().catch(() => ({})))); return false }
  return true
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-cron-secret')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' })

  const secret = req.headers['x-cron-secret'] ||
    (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' })

  const scannedAt = new Date().toISOString()
  const openingWindow = isOpeningWindow()
  try {
    const { data: allPrefs, error: prefsErr } = await supabase
      .from('alert_prefs').select('*')
      .or('email_alerts.eq.true,sms_on.eq.true,tg_token.not.is.null')
    if (prefsErr) return res.status(500).json({ error: prefsErr.message })
    if (!allPrefs?.length) return res.status(200).json({ sent: 0, scannedAt, note: 'No users with alerts enabled' })

    const clerkIds = allPrefs.map(p => p.clerk_user_id).filter(Boolean)
    const { data: activeSubs } = await supabase
      .from('subscriptions').select('clerk_id, status')
      .in('clerk_id', clerkIds).in('status', ['active', 'trialing'])

    const activeSet = new Set((activeSubs || []).map(s => s.clerk_id))
    const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
    const users     = allPrefs.filter(p => activeSet.has(p.clerk_user_id) || ADMIN_IDS.includes(p.clerk_user_id))
    if (!users.length) return res.status(200).json({ sent: 0, scannedAt, note: 'No active subscribers with alerts enabled' })

    // One query for everything the main engine currently has — no more
    // per-ticker Tradier calls, no more separate scoring. Same data every
    // user sees on the Scan tab.
    const [allSignals, marketCtx] = await Promise.all([fetchCurrentSignals(), fetchMarketBias()])
    if (!allSignals.length) return res.status(200).json({ sent: 0, scannedAt, note: 'No qualifying signals currently in scan_results' })

    const bySymbol = {}
    for (const row of allSignals) {
      if (!bySymbol[row.ticker]) bySymbol[row.ticker] = []
      bySymbol[row.ticker].push(row)
    }

    let sent = 0
    for (const user of users) {
      const watchlist  = user.symbols ? parseSymbols(user.symbols) : null   // null = no narrowing, full universe like the Scan tab
      const minScore   = user.min_edge_score ?? 50
      const candidates = watchlist ? watchlist.flatMap(sym => bySymbol[sym] || []) : allSignals
      const userAlerts = candidates
        .filter(row => row.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
      if (!userAlerts.length) continue

      const topGrade = userAlerts[0].grade
      const subject  = `OptionsEdge: ${userAlerts.length} ${topGrade}-grade alert${userAlerts.length > 1 ? 's' : ''} today`
      let notified = false

      // Email — fall back to Clerk's account email if the user enabled
      // alerts but never typed one into Alert Settings. Persisted back to
      // alert_prefs.alert_email on success so this is a one-time fetch per
      // user, not a Clerk API call on every single cron run forever, and so
      // the value becomes visible (and overridable) in Alert Settings
      // afterward rather than only ever existing transiently in memory.
      let emailToUse = user.alert_email
      if (user.email_alerts && !emailToUse) {
        emailToUse = await getClerkEmail(user.clerk_user_id)
        if (emailToUse) {
          const { error: backfillErr } = await supabase
            .from('alert_prefs')
            .update({ alert_email: emailToUse, updated_at: new Date().toISOString() })
            .eq('clerk_user_id', user.clerk_user_id)
          if (backfillErr) console.error(`[alerts/send] alert_email backfill failed for ${user.clerk_user_id}:`, backfillErr.message)
        }
      }

      if (user.email_alerts && emailToUse) { const ok = await sendEmail(emailToUse, subject, buildEmailHtml(userAlerts, marketCtx, openingWindow)); if (ok) { notified = true; console.log(`Email → ${emailToUse}`) } }
      // SMS — ADMIN-ONLY for now, per explicit product decision
      // (2026-06-28): Twilio is still trial, costs real money per message,
      // and isn't worth opening to real users until there's enough volume
      // (10+) to justify it. prefs.js already blocks a non-admin from
      // ENABLING sms_alerts going forward — this is the send-time backstop
      // for any row that already had sms_on set before that gate existed.
      // Same reasoning/pattern as the Telegram admin-only restriction
      // directly below.
      if (ADMIN_IDS.includes(user.clerk_user_id) && user.sms_on && user.phone_number) { const ok = await sendSms(user.phone_number, buildSmsText(userAlerts, marketCtx, openingWindow)); if (ok) notified = true }
      // Telegram — ADMIN-ONLY per explicit product decision (2026-06-28):
      // unlike email/sms_on, this channel has no per-user opt-in toggle in
      // alert_prefs at all — having a tg_token saved was the ONLY gate,
      // meaning any user who ever linked Telegram was permanently
      // subscribed with no way to opt out from Alert Settings. Restricting
      // to ADMIN_IDS closes that real consent gap rather than building a
      // new toggle for a channel that isn't meant to reach regular users.
      // Reuses the SAME ADMIN_IDS already computed above (line ~311) for
      // the subscription-bypass check — one source of truth for "is this
      // an admin," not a second, parallel definition.
      if (ADMIN_IDS.includes(user.clerk_user_id) && user.tg_token && user.tg_chat_id) {
        // FIX: tg_token is now stored encrypted — decrypt before use.
        const tgToken = decryptSecret(user.tg_token)
        if (tgToken) { const ok = await sendTg(tgToken, user.tg_chat_id, buildTgText(userAlerts, marketCtx, openingWindow)); if (ok) notified = true }
      }
      if (notified) sent++
    }

    return res.status(200).json({ sent, signalsConsidered: allSignals.length, bias: marketCtx.bias, openingWindow, scannedAt })
  } catch (e) {
    console.error('alerts/send fatal:', e)
    return res.status(500).json({ error: e.message })
  }
}
