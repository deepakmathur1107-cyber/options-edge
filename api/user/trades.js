// api/user/trades.js
// GET  /api/user/trades       — fetch user's trades
// POST /api/user/trades       — save a new trade
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
  // Admin always active
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

  // ── GET — fetch trades ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('clerk_id', clerkId)
      .order('logged_at', { ascending: false })
      .limit(200)

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ trades: data || [] })
  }

  // ── POST — save trade ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    body = body || {}

    // Map frontend field names → exact Supabase schema columns
    const row = {
      clerk_id:         clerkId,
      ticker:           body.ticker    || body.sym    || '',
      type:             body.type      || 'Call',
      status:           body.status    || 'Open',
      entry:            body.entry     !== undefined ? String(body.entry)     : null,
      exit_price:       body.exitPrice !== undefined ? String(body.exitPrice) : null,
      pnl:              body.pnl       !== undefined ? parseFloat(body.pnl) || 0 : 0,
      contracts:        body.contracts !== undefined ? parseInt(body.contracts) || 1 : 1,
      strike:           body.strike    || null,
      expiry:           body.expiry    || null,
      notes:            body.notes     || null,
      conviction:       body.conviction !== undefined ? parseFloat(body.conviction) || null : null,
      iv_at_entry:      body.iv        !== undefined ? parseFloat(body.iv) || null : null,
      chg_pct_at_entry: body.chgPctAtEntry !== undefined ? parseFloat(body.chgPctAtEntry) || null : null,
      be_req_pct:       body.breakevenReqPct !== undefined ? parseFloat(body.breakevenReqPct) || null : null,
      hard_block_count: body.hardBlockCount !== undefined ? parseInt(body.hardBlockCount) || 0 : 0,
      grade:            body.grade     || null,
      logged_at:        new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('trades')
      .insert(row)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ trade: data })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
