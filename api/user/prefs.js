// api/user/prefs.js
// GET  /api/user/prefs  — fetch alert preferences
// POST /api/user/prefs  — save alert preferences
// Admins bypass subscription check entirely.

const { createClient } = require('@supabase/supabase-js')

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

// ── Inline JWT decode (no SDK) ────────────────────────────────────────────────
function b64d(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad  = b64.length % 4 ? '='.repeat(4 - b64.length % 4) : ''
  return Buffer.from(b64 + pad, 'base64')
}

async function getClerkId(authHeader) {
  const token = (authHeader || '').replace('Bearer ', '').trim()
  if (!token) return null
  try {
    const parts   = token.split('.')
    if (parts.length !== 3) return null
    const header  = JSON.parse(b64d(parts[0]).toString('utf8'))
    const payload = JSON.parse(b64d(parts[1]).toString('utf8'))
    if (payload.exp && Date.now() / 1000 > payload.exp) return null
    const clerkKey = process.env.CLERK_SECRET_KEY
    if (!clerkKey) return null
    const jwksRes = await fetch('https://api.clerk.com/v1/jwks',
      { headers: { Authorization: 'Bearer ' + clerkKey } })
    if (!jwksRes.ok) return null
    const jwks   = await jwksRes.json()
    const jwkKey = jwks.keys?.find(k => k.kid === header.kid)
    if (!jwkKey) return null
    const crypto = require('crypto')
    const keyObj = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
    const valid  = crypto.verify(
      'sha256',
      Buffer.from(parts[0] + '.' + parts[1]),
      { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
      b64d(parts[2])
    )
    return valid ? payload.sub : null
  } catch { return null }
}

async function hasActiveSub(clerkId, supabase) {
  if (ADMIN_IDS.includes(clerkId)) return true
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('clerk_id', clerkId)
      .maybeSingle()
    const s = data?.status || 'inactive'
    return s === 'active' || s === 'trialing'
  } catch { return false }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const clerkId = await getClerkId(req.headers.authorization)
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Subscription gate (admins skip)
  if (!ADMIN_IDS.includes(clerkId)) {
    const active = await hasActiveSub(clerkId, supabase)
    if (!active) return res.status(402).json({ error: 'Subscription required' })
  }

  // ── GET — fetch prefs ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('clerk_id', clerkId)
      .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ prefs: data || null })
  }

  // ── POST — save prefs ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    body = body || {}

    const row = {
      clerk_id:        clerkId,
      email_on:        body.email_on        !== undefined ? Boolean(body.email_on)        : true,
      min_conviction:  body.min_conviction  !== undefined ? parseInt(body.min_conviction) : 80,
      watchlist:       body.watchlist       || 'NVDA,AAPL,MSFT,SPY,TSLA',
      updated_at:      new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('alert_prefs')
      .upsert(row, { onConflict: 'clerk_id' })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ prefs: data })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
