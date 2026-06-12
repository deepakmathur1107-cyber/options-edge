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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // ── Auth — full JWT signature verification ────────────────────────────────
  const { clerkId, isAdmin, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })

  // ── FEEDBACK — POST submit, GET fetch (admin) ──────────────────────────────
  if (req.query.action === 'feedback') {

    if (req.method === 'POST') {
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
      },
    })
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {}

    // Only active subscribers (or admins) can enable alert delivery
    if (!isAdmin && (body.email_alerts || body.sms_alerts)) {
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
