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

  // ── GET — fetch feedback + optional app stats (admin only) ─────────────────
  if (req.method === 'GET') {
    const { clerkId } = await getAuth(req)
    if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })
    if (!ADMIN_IDS.includes(clerkId)) return res.status(403).json({ error: 'Admin only' })

    // ?stats=1 — return app health + user stats alongside feedback
    if (req.query.stats === '1') {
      const [feedbackRes, subsRes, tradesRes, briefRes] = await Promise.allSettled([
        // Feedback by type
        supabase.from('feedback').select('type').order('created_at', { ascending: false }).limit(500),
        // Subscription stats
        supabase.from('subscriptions').select('status, plan, created_at'),
        // Trade log count
        supabase.from('trades').select('id', { count: 'exact', head: true }),
        // Last morning brief
        supabase.from('morning_brief').select('generated_at').order('generated_at', { ascending: false }).limit(1),
      ])

      const feedbackData  = feedbackRes.status  === 'fulfilled' ? feedbackRes.value.data  || [] : []
      const subsData      = subsRes.status       === 'fulfilled' ? subsRes.value.data      || [] : []
      const tradesCount   = tradesRes.status     === 'fulfilled' ? tradesRes.value.count   || 0  : 0
      const briefData     = briefRes.status      === 'fulfilled' ? briefRes.value.data     || [] : []

      // Subscription breakdown
      const subStats = {
        total:    subsData.length,
        active:   subsData.filter(s => s.status === 'active').length,
        trialing: subsData.filter(s => s.status === 'trialing').length,
        past_due: subsData.filter(s => s.status === 'past_due').length,
        canceled: subsData.filter(s => s.status === 'canceled' || s.status === 'inactive').length,
      }

      // New users this week
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
      subStats.newThisWeek = subsData.filter(s => s.created_at > oneWeekAgo).length

      // Feedback breakdown
      const fbStats = feedbackData.reduce((acc, fb) => {
        acc[fb.type] = (acc[fb.type] || 0) + 1
        return acc
      }, {})

      // App health checks
      const tradierMode = process.env.TRADIER_MODE || 'unknown'
      const hasRedis    = !!(process.env.UPSTASH_REDIS_REST_URL)
      const hasFinnhub  = !!(process.env.FINNHUB_API_KEY)
      const hasNinjas   = !!(process.env.API_NINJAS_KEY)

      return res.status(200).json({
        feedback:  feedbackData.slice(0, 200),
        stats: {
          subscriptions: subStats,
          feedback:      { total: feedbackData.length, byType: fbStats },
          trades:        { total: tradesCount },
          lastBrief:     briefData[0]?.generated_at || null,
          health: {
            tradierMode,
            redis:    hasRedis   ? '✅ configured' : '❌ missing',
            finnhub:  hasFinnhub ? '✅ configured' : '❌ missing',
            apiNinjas: hasNinjas ? '✅ configured' : '❌ missing',
          }
        }
      })
    }

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
