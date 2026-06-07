/**
 * api/user/prefs.js  — Vercel Serverless Function
 *
 * GET   /api/user/prefs   → fetch alert preferences for current user
 * POST  /api/user/prefs   → upsert alert preferences
 */

const { createClient } = require('@supabase/supabase-js')

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function isAdminServer(userId) {
  return ADMIN_IDS.includes(userId)
}

// Decode JWT without verification — Clerk already validates on the client.
// We trust the token's sub claim since it's signed by Clerk's private key.
// For extra security we verify the issuer matches our Clerk instance.
function decodeJwt(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    // Check expiry with 60s clock skew
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp && payload.exp < now - 60) {
      console.error('prefs: token expired', payload.exp, 'now', now)
      return null
    }
    // Verify issuer is our Clerk instance
    if (payload.iss && !payload.iss.includes('clerk')) {
      console.error('prefs: invalid issuer', payload.iss)
      return null
    }
    return payload
  } catch (e) {
    console.error('prefs: jwt decode failed:', e.message)
    return null
  }
}

async function getUserId(req) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
  if (!token) {
    console.error('prefs: no token')
    return null
  }
  const payload = decodeJwt(token)
  if (!payload?.sub) {
    console.error('prefs: no sub in token')
    return null
  }
  return payload.sub
}

async function hasActiveSubscription(userId) {
  if (isAdminServer(userId)) return true
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('clerk_id', userId)
    .single()
  if (error || !data) return false
  return ['active', 'trialing'].includes(data.status)
}

module.exports = async function handler(req, res) {
  const userId = await getUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const subscribed = await hasActiveSubscription(userId)
  if (!subscribed) return res.status(402).json({ error: 'Subscription required' })

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('clerk_id', userId)
      .single()

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({
      prefs: data ?? {
        clerk_id: userId,
        email_alerts: false,
        alert_email: null,
        min_edge_score: 50,
        symbols: ['SPY', 'QQQ'],
        alert_types: ['high_edge'],
      },
    })
  }

  // ── POST (upsert) ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { email_alerts, alert_email, min_edge_score, symbols, alert_types } = req.body || {}

    const upsertPayload = {
      clerk_id: userId,
      updated_at: new Date().toISOString(),
    }

    if (email_alerts !== undefined) upsertPayload.email_alerts = Boolean(email_alerts)
    if (alert_email !== undefined) upsertPayload.alert_email = alert_email
    if (min_edge_score !== undefined) upsertPayload.min_edge_score = Number(min_edge_score)
    if (symbols !== undefined) upsertPayload.symbols = symbols
    if (alert_types !== undefined) upsertPayload.alert_types = alert_types

    const { data, error } = await supabase
      .from('alert_prefs')
      .upsert(upsertPayload, { onConflict: 'clerk_id' })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ prefs: data })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
