/**
 * api/feedback.js
 * POST /api/feedback  — submit feedback (any authenticated user)
 * GET  /api/feedback  — fetch all feedback (admin only)
 *
 * Supabase table: feedback
 * Columns: id, clerk_user_id, email, type, message, created_at
 */
const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('./_lib/auth')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // ── POST — submit feedback ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    // Auth optional — allow anonymous but prefer authenticated
    const { clerkId } = await getAuth(req).catch(() => ({ clerkId: null }))

    let body = req.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    body = body || {}

    const message = (body.message || '').trim()
    const type    = ['suggestion','bug','praise','other'].includes(body.type) ? body.type : 'other'
    const email   = (body.email || '').trim() || null

    if (!message || message.length < 5) {
      return res.status(400).json({ error: 'Message too short' })
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long (max 2000 chars)' })
    }

    const { error } = await supabase.from('feedback').insert({
      clerk_user_id: clerkId || null,
      email,
      type,
      message,
    })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ── GET — fetch all feedback (admin only) ───────────────────────────────────
  if (req.method === 'GET') {
    const { clerkId } = await getAuth(req)
    if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })
    if (!ADMIN_IDS.includes(clerkId)) return res.status(403).json({ error: 'Admin only' })

    const { data, error } = await supabase
      .from('feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ feedback: data || [] })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
