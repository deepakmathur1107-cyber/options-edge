/**
 * api/user/prefs.js — Vercel Serverless Function
 *
 * GET  /api/user/prefs  → fetch alert preferences
 * POST /api/user/prefs  → upsert alert preferences
 *
 * Supabase table: alert_prefs
 * Confirmed columns: id, clerk_user_id, email_alerts (boolean),
 *   min_edge_score (integer), alert_timing (text), symbols (text),
 *   alert_email (text), alert_types (ARRAY), tg_token, tg_chat_id,
 *   sms_on (boolean), phone_number (text), updated_at, created_at
 */

const { createClient } = require('@supabase/supabase-js')

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function decodeJwt(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    )
  } catch { return null }
}

async function getUserId(req) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  return decodeJwt(token)?.sub || null
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const userId = await getUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const isAdmin = ADMIN_IDS.includes(userId)

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('clerk_user_id', userId)
      .maybeSingle()

    if (error) {
      console.error('prefs GET error:', error)
      return res.status(500).json({ error: error.message })
    }

    const row = data || {}

    // symbols is stored as comma-separated text e.g. "SPY,QQQ"
    const symbolsArr = row.symbols
      ? row.symbols.split(',').map(s => s.trim()).filter(Boolean)
      : ['SPY', 'QQQ']

    return res.status(200).json({
      prefs: {
        email_alerts:   row.email_alerts   ?? false,
        alert_email:    row.alert_email    ?? '',
        min_edge_score: row.min_edge_score ?? 50,
        symbols:        symbolsArr,
        sms_alerts:     row.sms_on         ?? false,
        phone_number:   row.phone_number   ?? '',
      },
    })
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {}

    const rawSymbols = Array.isArray(body.symbols) ? body.symbols : ['SPY', 'QQQ']
    const MAX_SYMBOLS = isAdmin ? 999 : 5
    const symbolsText = rawSymbols
      .slice(0, MAX_SYMBOLS)
      .map(s => s.toUpperCase().trim())
      .filter(Boolean)
      .join(',')

    const payload = {
      clerk_user_id:  userId,
      email_alerts:   body.email_alerts   ?? false,
      alert_email:    (body.alert_email   || '').trim(),
      min_edge_score: body.min_edge_score ?? 50,
      symbols:        symbolsText,
      sms_on:         body.sms_alerts     ?? false,
      phone_number:   (body.phone_number  || '').trim(),
      updated_at:     new Date().toISOString(),
    }

    console.log('prefs upsert:', JSON.stringify(payload))

    const { data, error } = await supabase
      .from('alert_prefs')
      .upsert(payload, { onConflict: 'clerk_user_id' })
      .select()
      .single()

    if (error) {
      console.error('prefs POST error:', JSON.stringify(error))
      return res.status(500).json({ error: error.message, detail: error.details || null })
    }

    return res.status(200).json({ ok: true, prefs: data })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
