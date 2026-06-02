// api/user/trades.js
// GET /api/user/trades         — fetch all trades for the user
// POST /api/user/trades        — create a new trade
// PATCH /api/user/trades?id=xx — update a trade (close it, add P&L etc.)
// DELETE /api/user/trades?id=xx — delete a trade

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
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

  // ── GET — fetch all trades ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('clerk_id', clerkUserId)
      .order('logged_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ trades: data || [] })
  }

  // ── POST — create trade ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const trade = {
      clerk_id:        clerkUserId,
      ticker:          body.ticker          || '',
      type:            body.type            || 'Call',
      status:          body.status          || 'Open',
      entry:           body.entry           || '',
      exit_price:      body.exitPrice       || '',
      pnl:             body.pnl             ? parseFloat(body.pnl) : null,
      contracts:       body.contracts       || '1',
      strike:          body.strike          || '',
      expiry:          body.expiry          || '',
      conviction:      body.conviction      ? parseFloat(body.conviction) : null,
      iv_at_entry:     body.iv              ? parseFloat(body.iv) : null,
      chg_pct_at_entry:body.chgPctAtEntry   ? parseFloat(body.chgPctAtEntry) : null,
      be_req_pct:      body.breakevenReqPct ? parseFloat(body.breakevenReqPct) : null,
      hard_block_count:body.hardBlockCount  ? parseInt(body.hardBlockCount) : 0,
      grade:           body.grade           || '',
      notes:           body.notes           || '',
      logged_at:       new Date().toISOString(),
    }
    const { data, error } = await supabase.from('trades').insert(trade).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ trade: data })
  }

  // ── PATCH — update trade ──────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing ?id=' })

    const updates = {}
    if (body.status    !== undefined) updates.status     = body.status
    if (body.exitPrice !== undefined) updates.exit_price = body.exitPrice
    if (body.pnl       !== undefined) updates.pnl        = parseFloat(body.pnl)
    if (body.notes     !== undefined) updates.notes      = body.notes

    const { data, error } = await supabase
      .from('trades')
      .update(updates)
      .eq('id', id)
      .eq('clerk_id', clerkUserId)   // security: can only update own trades
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ trade: data })
  }

  // ── DELETE — delete trade ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing ?id=' })
    const { error } = await supabase
      .from('trades')
      .delete()
      .eq('id', id)
      .eq('clerk_id', clerkUserId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ deleted: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
