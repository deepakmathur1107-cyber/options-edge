// api/user/prefs.js
// GET /api/user/prefs  — fetch alert preferences
// PUT /api/user/prefs  — save alert preferences

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad  = b64.length % 4 ? '='.repeat(4 - b64.length % 4) : ''
  return Buffer.from(b64 + pad, 'base64')
}
async function verifyClerkJWT(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const header  = JSON.parse(base64urlDecode(parts[0]).toString('utf8'))
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'))
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('Token expired')
  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: 'Bearer ' + process.env.CLERK_SECRET_KEY }
  })
  if (!jwksRes.ok) throw new Error('JWKS fetch failed')
  const jwks   = await jwksRes.json()
  const jwkKey = jwks.keys?.find(k => k.kid === header.kid)
  if (!jwkKey) throw new Error('No matching key')
  const crypto = require('crypto')
  const keyObj = crypto.createPublicKey({ key: jwkKey, format: 'jwk' })
  const valid  = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(parts[2]))
  if (!valid) throw new Error('Invalid signature')
  return payload
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await verifyClerkJWT(token)
    clerkUserId   = payload.sub
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed: ' + e.message })
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {}

  if (req.method === 'GET') {
    const { data } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('clerk_id', clerkUserId)
      .maybeSingle()
    return res.status(200).json(data || {
      email_on:        true,
      min_conviction:  80,
      alert_timing:    'immediate',
      watchlist:       '',
      tg_token:        '',
      tg_chat_id:      '',
    })
  }

  if (req.method === 'PUT') {
    const prefs = {
      clerk_id:       clerkUserId,
      email_on:       body.emailOn       ?? true,
      min_conviction: body.minConviction ?? 80,
      alert_timing:   body.alertTiming   || 'immediate',
      watchlist:      body.watchlist     || '',
      tg_token:       body.tgToken       || '',
      tg_chat_id:     body.tgChatId      || '',
      updated_at:     new Date().toISOString(),
    }
    const { data, error } = await supabase
      .from('alert_prefs')
      .upsert(prefs, { onConflict: 'clerk_id' })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
