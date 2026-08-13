// api/user/trades.js
// GET    /api/user/trades        — fetch user's trades
// POST   /api/user/trades        — save a new trade
// PUT    /api/user/trades?id=X   — close/update a trade
// DELETE /api/user/trades?id=X   — delete a trade
//
// Supabase table: trades
// Key columns: clerk_user_id, ticker, type, option_type, action,
//   entry, entry_price, close_price, exit_price, strike, expiration,
//   contracts, status, pnl, conviction, grade, notes, created_at,
//   close_date, closed_at, updated_at

const { createClient } = require('@supabase/supabase-js')
const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { rateLimit } = require('../_lib/rateLimit')

async function fetchStockPrices(symbols) {
  if(!symbols.length||!process.env.TRADIER_TOKEN) return new Map()
  const base=(process.env.TRADIER_MODE||'production')==='sandbox'?'https://sandbox.tradier.com/v1':'https://api.tradier.com/v1'
  const response=await fetch(base+'/markets/quotes?symbols='+encodeURIComponent(symbols.join(','))+'&greeks=false',{
    headers:{Authorization:'Bearer '+process.env.TRADIER_TOKEN,Accept:'application/json'},
  })
  if(!response.ok) throw new Error('Stock quote request failed ('+response.status+')')
  const json=await response.json(),raw=json?.quotes?.quote
  const quotes=!raw?[]:Array.isArray(raw)?raw:[raw]
  return new Map(quotes.map(quote=>[quote.symbol,Number(quote.last||quote.close)]).filter(([,price])=>Number.isFinite(price)&&price>0))
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

function num(v)  { const n = parseFloat(v);  return isNaN(n) ? null : n }
function int_(v) { const n = parseInt(v);    return isNaN(n) ? null : n }

// trades.status has historically been written with inconsistent casing
// ('Open', 'closed', 'Closed') by different callers over time. Normalize
// to the canonical title-case values here so every write path — manual
// close, scanner push-to-journal, future auto-close logic — lands on the
// same casing, instead of relying on each caller to get it right.
// Unrecognized values pass through as-is rather than being coerced, so a
// genuinely new status surfaces instead of silently disappearing into a
// wrong bucket.
const STATUS_MAP = { open: 'Open', closed: 'Closed', inactive: 'inactive' }
function normStatus(v) {
  if (v == null) return v
  const mapped = STATUS_MAP[String(v).toLowerCase()]
  return mapped || v
}

// trades.type has mixed short-form casing ('call'/'Call') AND a separate
// short-form vs. long-form naming split ('Call' vs 'Long Call') from
// different eras of the app. This only fixes the casing half — it does
// NOT collapse 'Call'/'Put' into 'Long Call'/'Long Put', since that would
// be reinterpreting what older rows mean, not just respelling them.
const TYPE_CASE_MAP = { call: 'Call', put: 'Put' }
function normType(v) {
  if (v == null) return v
  const mapped = TYPE_CASE_MAP[String(v).toLowerCase()]
  return mapped || v
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Note: the frontend route is already wrapped in SubscriptionGate, so reaching
  // this endpoint normally implies an active subscription. This check exists only
  // to catch the edge case where a subscription expired/was canceled between page
  // load and this request (Stripe webhook lag, browser tab left open past expiry, etc).
  if (!ADMIN_IDS.includes(clerkId)) {
    const active = await hasActiveSub(clerkId, supabase)
    if (!active) {
      return res.status(402).json({
        error: 'Your subscription has expired or was canceled. Please renew to continue using the trade journal.',
        code: 'SUBSCRIPTION_EXPIRED',
      })
    }
  }

  // FIX: basic abuse guard on writes only (GET reads are unthrottled).
  // 30/min is generous for a real trader logging entries/exits, restrictive
  // for a runaway script or retry loop.
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    const { allowed } = await rateLimit(`trades:${clerkId}`, 30, 60)
    if (!allowed) {
      return res.status(429).json({ error: 'Too many requests — please slow down.' })
    }
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('clerk_user_id', clerkId)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('trades GET:', error.message)
      return res.status(500).json({ error: error.message })
    }
    const rows=data||[]
    const {data:outcomes,error:outcomeError}=rows.length
      ? await supabase.from('trade_outcomes').select('trade_id,outcome,hit_target_at,hit_stop_at,resolved_at,resolution_method').in('trade_id',rows.map(row=>row.id))
      : {data:[],error:null}
    if(outcomeError) console.error('trade outcomes GET:',outcomeError.message)
    const byTrade=new Map((outcomes||[]).map(outcome=>[outcome.trade_id,outcome]))
    const stockSymbols=[...new Set(rows.filter(row=>String(row.option_type).toLowerCase()==='stock'&&String(row.status).toLowerCase()==='open'&&!row.exit_price).map(row=>row.ticker))]
    let stockPrices=new Map()
    try { stockPrices=await fetchStockPrices(stockSymbols) }
    catch(error) { console.error('stock prices GET:',error.message) }
    const pricedAt=new Date().toISOString()
    return res.status(200).json({ trades:rows.map(row=>({
      ...row,
      tracked_outcome:byTrade.get(row.id)||null,
      current_price:String(row.option_type).toLowerCase()==='stock'?(stockPrices.get(row.ticker)||null):null,
      current_price_at:String(row.option_type).toLowerCase()==='stock'&&stockPrices.has(row.ticker)?pricedAt:null,
    })) })
  }

  // ── POST — insert new trade ────────────────────────────────────────────────
  if (req.method === 'POST') {
    const b = parseBody(req)

    // Accept both TradeLog field names and scanner push-to-journal names
    const ticker = (b.ticker || b.symbol || '').toUpperCase().trim()
    if (!ticker) return res.status(400).json({ error: 'ticker is required' })

    // Enforce per-user row limit (500 trades max, admins unlimited)
    const MAX_TRADES = ADMIN_IDS.includes(clerkId) ? Infinity : 500
    if (MAX_TRADES !== Infinity) {
      const { count } = await supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('clerk_user_id', clerkId)
      if ((count || 0) >= MAX_TRADES) {
        return res.status(429).json({ error: `Trade log limit reached (${MAX_TRADES} max). Archive or delete old trades to add new ones.` })
      }
    }

    const row = {
      clerk_user_id:    clerkId,
      ticker,
      // TradeLog sends option_type ('call'/'put'); scanner sends type ('Call'/'Put')
      option_type:      (b.option_type || b.type  || 'call').toLowerCase(),
      type:             normType(b.type || b.option_type || 'call'),
      action:           b.action       || 'buy',
      strike:           b.strike       != null ? String(b.strike) : null,
      expiration:       b.expiration   || b.expiry || null,
      contracts:        b.contracts    != null ? String(b.contracts) : '1',
      // entry — stored as text (legacy) and numeric (new)
      entry:            b.entry        != null ? String(b.entry)
                      : b.entry_price  != null ? String(b.entry_price) : null,
      entry_price:      b.entry_price  != null ? num(b.entry_price)
                      : b.entry        != null ? num(b.entry) : null,
      // target_price/stop_price — captured at entry so a future hold/close
      // verdict engine (item 5) has a concrete level to re-evaluate against,
      // instead of having to invent a new target/stop at check-time using
      // only current data. Accepts the scanner's field names (target/stop,
      // matching scan_results/signal_history's own naming) as well as a
      // generic targetPrice/stopPrice for manual trade-log entries that
      // didn't originate from a scan signal. Null is a valid, expected value
      // for manual entries with no target/stop set -- NOT backfilled or
      // guessed here.
      target_price:     num(b.target ?? b.targetPrice ?? b.target_price),
      stop_price:        num(b.stop ?? b.stopPrice ?? b.stop_price),
      // timeframe — the raw TF_CONFIG key (e.g. "Swing (21–45 DTE)"), added
      // alongside target_price/stop_price for the same item-5 verdict-engine
      // need: TF_WEIGHT_PROFILES lookups require this exact key string, not
      // the human-readable tfLabel ("Swing Trade"). Null for manual entries
      // or older payloads without it -- the verdict engine must skip scoring
      // on null-timeframe trades rather than default to a guessed profile
      // (session decision: skip explicitly, do not approximate).
      timeframe:        b.timeframe || null,
      status:           normStatus(b.status) || 'Open',
      notes:            b.notes        || null,
      // Optional scoring fields from scanner
      conviction:       num(b.conviction),
      iv_at_entry:      num(b.iv || b.iv_at_entry),
      chg_pct_at_entry: num(b.chgPctAtEntry || b.chg_pct_at_entry),
      be_req_pct:       num(b.breakevenReqPct || b.be_req_pct),
      hard_block_count: int_(b.hardBlockCount || b.hard_block_count) || 0,
      grade:            b.grade || null,
      premium:          num(b.premium || b.entry_price || b.entry),
      strategy:         b.strategy || null,
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('trades')
      .insert(row)
      .select()
      .single()

    if (error) {
      console.error('trades POST:', error.message, JSON.stringify(row))
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ trade: data })
  }

  // ── PUT — update/close trade ───────────────────────────────────────────────
  if (req.method === 'PUT') {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing ?id=' })
    const b = parseBody(req)

    const updates = { updated_at: new Date().toISOString() }
    if (b.exit_price  != null) { updates.exit_price  = num(b.exit_price);  updates.close_price = String(b.exit_price) }
    if (b.close_price != null) { updates.close_price = String(b.close_price); updates.exit_price = num(b.close_price) }
    if (b.status      != null)   updates.status      = normStatus(b.status)
    if (b.type        != null)   updates.type        = normType(b.type)
    if (b.closed_at   != null)   updates.closed_at   = b.closed_at
    if (b.close_date  != null)   updates.close_date  = b.close_date
    if (b.pnl         != null)   updates.pnl         = num(b.pnl)
    if (b.notes       != null)   updates.notes       = b.notes

    const { data, error } = await supabase
      .from('trades')
      .update(updates)
      .eq('id', id)
      .eq('clerk_user_id', clerkId)
      .select()
      .single()

    if (error) {
      console.error('trades PUT:', error.message)
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ trade: data })
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'Missing ?id=' })

    const { error } = await supabase
      .from('trades')
      .delete()
      .eq('id', id)
      .eq('clerk_user_id', clerkId)

    if (error) {
      console.error('trades DELETE:', error.message)
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

module.exports._test={fetchStockPrices}
