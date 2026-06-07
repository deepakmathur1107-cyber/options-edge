/**
 * api/user/trades.js  — Vercel Serverless Function
 *
 * GET    /api/user/trades          → list trades for current user
 * POST   /api/user/trades          → create a trade
 * PUT    /api/user/trades?id=<id>  → update a trade
 * DELETE /api/user/trades?id=<id>  → delete a trade
 *
 * Exact column names from trades table:
 * id, clerk_user_id, ticker, type, status, entry, close_price, pnl,
 * contracts, strike, expiration, conviction, iv_at_entry, chg_pct_at_entry,
 * be_req_pct, hard_block_count, grade, notes, created_at, option_type,
 * strategy, premium, close_date, updated_at, action,
 * entry_price, exit_price, closed_at
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

function toNum(val) {
  if (val == null) return null
  const n = Number(String(val).replace(/[^0-9.-]/g, ''))
  return isNaN(n) ? null : n
}

module.exports = async function handler(req, res) {
  const userId = await getUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const subscribed = await hasActiveSubscription(userId)
  if (!subscribed) return res.status(402).json({ error: 'Subscription required' })

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('clerk_user_id', userId)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ trades: data })
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {}

    // Normalise incoming field names — TradeLog sends symbol/entry_price,
    // legacy App.jsx journal sends ticker/entry/premium
    const ticker      = (body.symbol      || body.ticker  || '').toString().toUpperCase().trim()
    const option_type = body.option_type  || body.type    || 'call'
    const action      = body.action       || body.side    || 'buy'
    const expiration  = body.expiration   || body.expiry  || null
    const contracts   = body.contracts    != null ? body.contracts : 1
    const notes       = body.notes        || null
    const status      = body.status       || 'open'
    const strategy    = body.strategy     || null
    const grade       = body.grade        || null

    // Entry price: accept entry_price (TradeLog), premium, or entry (legacy)
    const entry_price = body.entry_price  != null ? toNum(body.entry_price)
                      : body.premium      != null ? toNum(body.premium)
                      : body.entry        != null ? toNum(body.entry)
                      : null

    // Keep legacy `entry` text field in sync (stores formatted string)
    const entry_text  = body.entry        || (entry_price != null ? String(entry_price) : null)

    if (!ticker) return res.status(400).json({ error: 'ticker / symbol is required' })

    const { data, error } = await supabase
      .from('trades')
      .insert({
        clerk_user_id:    userId,
        ticker,
        option_type,
        action,
        strategy,
        grade,
        status,
        notes,
        expiration,
        contracts:        body.contracts  != null ? String(contracts) : '1',
        strike:           body.strike     != null ? String(body.strike) : null,
        entry:            entry_text,
        entry_price,
        premium:          entry_price,    // keep premium in sync
        pnl:              toNum(body.pnl),
        conviction:       toNum(body.conviction),
        iv_at_entry:      toNum(body.iv),
        chg_pct_at_entry: toNum(body.chgPctAtEntry),
        be_req_pct:       toNum(body.breakevenReqPct),
        hard_block_count: toNum(body.hardBlockCount) || 0,
        // type mirrors option_type for legacy reads
        type:             option_type,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ trade: data })
  }

  // ── PUT ───────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    const body = req.body || {}
    const updates = {}

    if (body.status      !== undefined) updates.status      = body.status
    if (body.notes       !== undefined) updates.notes       = body.notes
    if (body.pnl         !== undefined) updates.pnl         = toNum(body.pnl)
    if (body.contracts   !== undefined) updates.contracts   = String(body.contracts)
    if (body.grade       !== undefined) updates.grade       = body.grade

    // Exit / close price — accept exit_price (TradeLog) or close_price (legacy)
    const exitVal = body.exit_price  != null ? toNum(body.exit_price)
                  : body.close_price != null ? toNum(body.close_price)
                  : undefined
    if (exitVal !== undefined) {
      updates.exit_price  = exitVal
      updates.close_price = String(exitVal)  // keep legacy field in sync
    }

    // Closed timestamp
    if (body.closed_at  !== undefined) updates.closed_at  = body.closed_at
    if (body.close_date !== undefined) updates.close_date = body.close_date

    // Entry price update
    if (body.entry_price !== undefined) {
      updates.entry_price = toNum(body.entry_price)
      updates.premium     = toNum(body.entry_price)
    }
    if (body.premium !== undefined) {
      updates.premium     = toNum(body.premium)
      updates.entry_price = toNum(body.premium)
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('trades')
      .update(updates)
      .eq('id', id)
      .eq('clerk_user_id', userId)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Trade not found' })
    return res.status(200).json({ trade: data })
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
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
