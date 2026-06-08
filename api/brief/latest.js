/**
 * api/brief/latest.js — Vercel Serverless Function
 *
 * GET /api/brief/latest
 *
 * Returns the cached morning brief from Supabase.
 * Called by all users — zero Claude API cost per user.
 * Requires valid Clerk JWT (subscription gate handled client-side).
 */

const { createClient } = require('@supabase/supabase-js')

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — must be a valid Clerk session
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  const payload = decodeJwt(token)
  if (!payload?.sub) return res.status(401).json({ error: 'Unauthorized' })

  const { data, error } = await supabase
    .from('morning_brief')
    .select('*')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('brief/latest error:', error)
    return res.status(500).json({ error: error.message })
  }

  if (!data) {
    return res.status(404).json({ error: 'No brief available yet', notGenerated: true })
  }

  const now = new Date()
  const isStale = new Date(data.expires_at) < now

  return res.status(200).json({
    brief: {
      tone:         data.tone,
      why:          data.why,
      events:       data.events,
      levels:       data.levels,
      bias:         data.bias,
      risk_trigger: data.risk_trigger,
    },
    generatedAt: data.generated_at,
    expiresAt:   data.expires_at,
    isStale,
  })
}
