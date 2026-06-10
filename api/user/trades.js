// api/user/trades.js
// GET    /api/user/trades        — fetch user's trades
// POST   /api/user/trades        — save a new trade
// PUT    /api/user/trades?id=X   — update (close) a trade
// DELETE /api/user/trades?id=X   — delete a trade

const { createClient } = require('@supabase/supabase-js')

const ADMIN_IDS = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

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

function parseBody(req) {
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  return body || {}
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const clerkId = await getClerkId(req.headers.authorization)
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  if (!ADMIN_IDS.includes(clerkId)) {
    const active = await hasActiveSub(clerkId, supabase)
    if (!active) return res.status(402).json({ error: 'Subscription required' })
  }

  // ── GET — fetch trades ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('clerk_id', clerkId)
      .order('logged_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('trades GET error:', error)
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ trades: data || [] })
  }

  // ── POST — insert new trade ────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = parseBody(req)

    // Support both TradeLog field names (symbol, entry_price, option_type, expiration)
    // and legacy App.jsx push-to-journal names (ticker, entry, type, expiry)
    const row = {
      clerk_id:    clerkId,
      symbol:      (body.symbol      || body.ticker || '').toUpperCase().trim(),
      option_type: (body.option_type || body.type   || 'call').toLowerCase(),
      action:      body.action       || 'buy',
      strike:      body.strike       != null ? parseFloat(body.strike)      || null : null,
      expiration:  body.expiration   || body.expiry || null,
      contracts:   body.contracts    != null ? parseInt(body.contracts)     || 1   : 1,
      entry_price: body.entry_price  != null ? parseFloat(body.entry_price) || null
                 : body.entry        != null ? parseFloat(body.entry)       || null : null,
      exit_price:  body.exit_price   != null ? parseFloat(body.exit_price)  || null
                 : body.exitPrice    != null ? parseFloat(body.exitPrice)   || null : null,
      status:      body.status       || 'open',
      notes:       body.notes        || null,
      // Optional scoring fields from scanner push-to-journal
      conviction:  body.conviction   != null ? parseFloat(body.conviction)  || null : null,
      grade:       body.grade        || null,
      logged_at:   new Date().toISOString(),
    }

    if (!row.symbol) return res.status(400).json({ error: 'Symbol is required' })

    const { data, error } = await supabase
      .from('trades')
      .insert(row)
      .select()
      .single()

    if (error) {
      console.error('trades POST error:', error)
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ trade: data })
  }

  // ── PUT — update trade (close out) ────────────────────────────────────────
  if (req.method === 'PUT') {
    const id   = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing ?id=' })
    const body = parseBody(req)

    const updates = {}
    if (body.exit_price  != null) updates.exit_price  = parseFloat(body.exit_price)  || null
    if (body.status      != null) updates.status      = body.status
    if (body.closed_at   != null) updates.closed_at   = body.closed_at
    if (body.notes       != null) updates.notes       = body.notes
    if (body.pnl         != null) updates.pnl         = parseFloat(body.pnl) || null

    const { data, error } = await supabase
      .from('trades')
      .update(updates)
      .eq('id', id)
      .eq('clerk_id', clerkId)   // user can only update their own trades
      .select()
      .single()

    if (error) {
      console.error('trades PUT error:', error)
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ trade: data })
  }

  // ── DELETE — remove trade ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing ?id=' })

    const { error } = await supabase
      .from('trades')
      .delete()
      .eq('id', id)
      .eq('clerk_id', clerkId)   // user can only delete their own trades

    if (error) {
      console.error('trades DELETE error:', error)
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
