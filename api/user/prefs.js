/**
 * api/user/prefs.js — Vercel Serverless Function
 *
 * GET  /api/user/prefs                  -> fetch alert preferences
 * POST /api/user/prefs                  -> upsert alert preferences
 * POST /api/user/prefs?action=feedback  -> submit user feedback
 * GET  /api/user/prefs?action=feedback  -> fetch all feedback (admin only)
 *
 * Feedback merged here to stay within Vercel Hobby 12-function limit.
 */

const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { encryptSecret } = require('../_lib/secretCrypto')
const { rateLimit } = require('../_lib/rateLimit')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// isValidE164 — server-side backstop, identical logic to App.jsx's client-
// side check. Defensive: the frontend already blocks a bad save, but this
// is the actual enforcement point — any other caller (a future mobile
// client, a script, a bug in a later frontend change) must still go
// through this check before a malformed number can ever reach the DB or
// be handed to Twilio. Deliberately no auto-prepended country code, same
// reasoning as the frontend — this product has no US-only restriction.
function isValidE164(raw) {
  const stripped = (raw || '').replace(/[\s\-().]/g, '')
  return /^\+[1-9]\d{1,14}$/.test(stripped)
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // ── Auth — full JWT signature verification ────────────────────────────────
  const { clerkId, isAdmin, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })

  // ── FEEDBACK — POST submit, GET fetch (admin) ──────────────────────────────
  if (req.query.action === 'feedback') {

    if (req.method === 'POST') {
      // FIX: same abuse guard as api/feedback.js, since this writes to the
      // same table via a second code path.
      const { allowed } = await rateLimit(`feedback:${clerkId}`, 5, 600)
      if (!allowed) {
        return res.status(429).json({ error: 'Too many submissions — please wait a few minutes and try again.' })
      }
      let body = req.body
      if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
      body = body || {}
      const message = (body.message || '').trim()
      const type    = ['suggestion','bug','praise','other'].includes(body.type) ? body.type : 'other'
      const email   = (body.email   || '').trim() || null
      if (!message || message.length < 5)    return res.status(400).json({ error: 'Message too short' })
      if (message.length > 2000)             return res.status(400).json({ error: 'Message too long' })
      const { error } = await supabase.from('feedback').insert({ clerk_user_id: clerkId, email, type, message })
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'GET') {
      if (!ADMIN_IDS.includes(clerkId)) return res.status(403).json({ error: 'Admin only' })
      const { data, error } = await supabase
        .from('feedback').select('*').order('created_at', { ascending: false }).limit(200)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ feedback: data || [] })
    }
  }



  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('clerk_user_id', clerkId)
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
        // FIX: tg_token is a live credential — never return its plaintext
        // value once saved. The UI only needs to know whether one is set,
        // same convention as never re-displaying a saved API key.
        tg_token_set:   !!row.tg_token,
        tg_chat_id:     row.tg_chat_id     ?? null,
      },
    })
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    // FIX: basic abuse guard. 20/min is generous for a person actively
    // adjusting settings, restrictive for a runaway script/retry loop.
    const { allowed } = await rateLimit(`prefs:${clerkId}`, 20, 60)
    if (!allowed) {
      return res.status(429).json({ error: 'Too many requests — please slow down.' })
    }

    const body = req.body || {}

    // SMS — ADMIN-ONLY for now, per explicit product decision (2026-06-28):
    // Twilio is still on a trial account and costs real money per message
    // even once upgraded. The frontend already hides this toggle from
    // non-admins, but that alone doesn't stop a direct POST to this
    // endpoint — this is the actual enforcement point, same reasoning as
    // why the Telegram admin-only restriction lives in alerts/send.js
    // itself rather than only in the UI that calls it.
    if (!isAdmin && body.sms_alerts) {
      return res.status(403).json({ error: 'SMS alerts are not yet available — coming soon.' })
    }

    // Only active subscribers (or admins) can enable alert delivery
    if (!isAdmin && body.email_alerts) {
      const { createClient } = require('@supabase/supabase-js')
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
      const { data: sub } = await sb
        .from('subscriptions')
        .select('status')
        .eq('clerk_id', clerkId)
        .maybeSingle()
      const s = sub?.status || 'inactive'
      if (s !== 'active' && s !== 'trialing') {
        return res.status(402).json({ error: 'Active subscription required to enable alerts' })
      }
    }

    const rawSymbols = Array.isArray(body.symbols) ? body.symbols : ['SPY', 'QQQ']
    const MAX_SYMBOLS = isAdmin ? 999 : 5
    const symbolsText = rawSymbols
      .slice(0, MAX_SYMBOLS)
      .map(s => s.toUpperCase().trim())
      .filter(Boolean)
      .join(',')

    // Reject rather than silently store a phone number Twilio would just
    // fail on later — same check as the frontend, enforced here as the
    // actual backstop (see isValidE164's comment above for why no country
    // code is ever assumed).
    if (body.sms_alerts && !isValidE164(body.phone_number)) {
      return res.status(400).json({
        error: 'Phone number must include a country code (e.g. +1, +44, +91) — no country is assumed.',
      })
    }

    const payload = {
      clerk_user_id:  clerkId,
      email_alerts:   body.email_alerts   ?? false,
      alert_email:    (body.alert_email   || '').trim(),
      min_edge_score: body.min_edge_score ?? 50,
      symbols:        symbolsText,
      sms_on:         body.sms_alerts     ?? false,
      phone_number:   (body.phone_number  || '').trim(),
      updated_at:     new Date().toISOString(),
    }
    // Admin-only: save Telegram credentials
    if (ADMIN_IDS.includes(clerkId)) {
      // FIX: encrypt the bot token at rest — previously stored in plaintext.
      // Only touch the column if the caller actually sent a new value
      // (frontend sends tg_token_set, not tg_token, once it's already
      // configured — see GET above — so an unrelated prefs save won't
      // accidentally overwrite/clear the stored token with undefined).
      if (body.tg_token !== undefined) {
        const raw = (body.tg_token || '').trim()
        if (raw) {
          try {
            payload.tg_token = encryptSecret(raw)
          } catch (e) {
            // FIX: previously an uncaught throw here (e.g. missing
            // SECRET_ENCRYPTION_KEY) produced a bare 500 with no useful
            // message. Surface the real cause instead.
            console.error('[prefs] encryptSecret failed:', e.message)
            return res.status(500).json({
              error: 'Server is not configured to store this securely (SECRET_ENCRYPTION_KEY missing or invalid). Contact admin.',
              detail: e.message,
            })
          }
        } else {
          payload.tg_token = null
        }
      }
      if (body.tg_chat_id !== undefined) payload.tg_chat_id = (body.tg_chat_id || '').trim() || null
    }

    console.log('prefs upsert for', clerkId)

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
