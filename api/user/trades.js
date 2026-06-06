/**
 * api/user/trades.js  — Vercel Serverless Function
 *
 * GET    /api/user/trades          → list trades for current user
 * POST   /api/user/trades          → create a trade
 * PUT    /api/user/trades?id=<id>  → update a trade
 * DELETE /api/user/trades?id=<id>  → delete a trade
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

function decodeJwt(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp && payload.exp < now - 60) return null
    if (payload.iss && !payload.iss.includes('clerk')) return null
    return payload
  } catch {
    return null
  }
}

async function getUserId(req) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const payload = decodeJwt(token)
  return payload?.sub || null
}

async function hasActiveSubscription(userId) {
  if (isAdminServer(userId)) return true
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('clerk_user_id', userId)
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
      .from('trades')
      .select('*')
      .eq('clerk_user_id', userId)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ trades: data })
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const {
      symbol, option_type, strategy, strike, expiration,
      contracts, premium, notes, status,
      // Legacy fields from App.jsx journal
      ticker, type, entry, exitPrice, pnl,
      expiry, date, conviction, iv, chgPctAtEntry,
      breakevenReqPct, hardBlockCount, grade,
    } = req.body || {}

    const { data, error } = await supabase
      .from('trades')
      .insert({
        clerk_user_id: userId,
        symbol: (symbol || ticker || '').toUpperCase(),
        option_type: option_type || type || 'call',
        strategy: strategy || null,
        strike: strike ? Number(strike) : null,
        expiration: expiration || expiry || null,
        contracts: Number(contracts || 1),
        premium: premium != null ? Number(premium)
          : entry ? Number(String(entry).replace(/[^0-9.]/g, '')) : null,
        notes: notes || null,
        status: status || 'open',
        pnl: pnl ? Number(String(pnl).replace(/[^0-9.-]/g, '')) : null,
        conviction: conviction ? Number(conviction) : null,
        iv_at_entry: iv ? Number(iv) : null,
        chg_pct_at_entry: chgPctAtEntry ? Number(chgPctAtEntry) : null,
        be_req_pct: breakevenReqPct ? Number(breakevenReqPct) : null,
        hard_block_count: hardBlockCount ? Number(hardBlockCount) : 0,
        grade: grade || null,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ trade: data })
  }

  // ── PUT ──────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    const allowed = ['status', 'close_price', 'close_date', 'notes', 'contracts', 'premium', 'pnl']
    const updates = {}
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) updates[key] = req.body[key]
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    const { data, error } = await supabase
      .from('trades')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('clerk_user_id', userId)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Trade not found' })
    return res.status(200).json({ trade: data })
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    const { error } = await supabase
      .from('trades')
      .delete()
      .eq('id', id)
      .eq('clerk_user_id', userId)

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ success: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
