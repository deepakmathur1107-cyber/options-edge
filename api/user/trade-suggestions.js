// api/user/trade-suggestions.js
//
// GET  /api/user/trade-suggestions
//   -> { suggestions: [...] }  -- all PENDING trade_close_suggestions for
//      the requesting user's own trades (joined for ticker/strike display).
//
// PUT  /api/user/trade-suggestions?id=<suggestion id>
//   body: { action: 'confirm' | 'dismiss' }
//   - 'dismiss': marks the suggestion resolved, status='dismissed'. Does
//     NOT touch the trade itself.
//   - 'confirm': marks the suggestion resolved, status='confirmed', AND
//     closes the underlying trade by setting status='Closed',
//     exit_price=trigger_mid (the price that triggered the suggestion).
//     This is the ONLY path that closes a trade based on a suggestion —
//     confirms the suggest-only design: nothing closes a trade without
//     this explicit user action hitting this exact endpoint with
//     action='confirm'.
//
// Ownership-checked the same pattern as verdict-history.js: every query
// filters through trades.clerk_user_id, so a user can't see or act on
// another user's suggestions even by guessing/incrementing an id.

const { createClient } = require('@supabase/supabase-js')
const { getAuth } = require('../_lib/auth')

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  if (req.method === 'GET') {
    // trades!inner with .eq('trades.clerk_user_id', ...) -- same documented
    // working pattern (table!inner(...) + .eq('table.column', value))
    // already verified earlier this session for the admin trade-outcomes
    // endpoint, applied here for ownership scoping instead of a display
    // join, same underlying mechanism.
    const { data, error } = await supabase
      .from('trade_close_suggestions')
      .select('id, trade_id, created_at, reason, trigger_mid, target_price, stop_price, status, trades!inner(ticker, option_type, strike, expiration, clerk_user_id)')
      .eq('status', 'pending')
      .eq('trades.clerk_user_id', clerkId)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ suggestions: data || [] })
  }

  if (req.method === 'PUT') {
    const suggestionId = req.query.id
    if (!suggestionId) return res.status(400).json({ error: 'Missing ?id=' })

    let body = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}) } catch { body = {} }
    const action = body.action
    if (action !== 'confirm' && action !== 'dismiss') {
      return res.status(400).json({ error: "action must be 'confirm' or 'dismiss'" })
    }

    // Ownership check FIRST, as its own query, joined through to the
    // trade -- same reasoning as verdict-history.js: a suggestion id
    // belonging to another user's trade must return a clean 404, not
    // silently act on data that isn't the requester's.
    const { data: suggestion, error: fetchErr } = await supabase
      .from('trade_close_suggestions')
      .select('id, trade_id, trigger_mid, status, trades!inner(clerk_user_id)')
      .eq('id', suggestionId)
      .eq('trades.clerk_user_id', clerkId)
      .maybeSingle()

    if (fetchErr) return res.status(500).json({ error: fetchErr.message })
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' })
    if (suggestion.status !== 'pending') {
      return res.status(409).json({ error: `Suggestion already ${suggestion.status}` })
    }

    const { error: updateSuggestionErr } = await supabase
      .from('trade_close_suggestions')
      .update({ status: action === 'confirm' ? 'confirmed' : 'dismissed', resolved_at: new Date().toISOString() })
      .eq('id', suggestionId)

    if (updateSuggestionErr) return res.status(500).json({ error: updateSuggestionErr.message })

    if (action === 'confirm') {
      // The ONLY place a trade gets closed as a result of a suggestion --
      // explicit user action via this PUT, never the cron itself.
      const { error: closeErr } = await supabase
        .from('trades')
        .update({
          status: 'Closed',
          exit_price: suggestion.trigger_mid,
          updated_at: new Date().toISOString(),
        })
        .eq('id', suggestion.trade_id)
      if (closeErr) {
        // Suggestion is already marked confirmed at this point -- a failed
        // trade-close here is a real inconsistency (confirmed suggestion,
        // still-open trade) worth surfacing as an error rather than
        // silently swallowing, even though the suggestion update itself
        // already succeeded.
        return res.status(500).json({ error: `Suggestion confirmed but trade close failed: ${closeErr.message}` })
      }
    }

    return res.status(200).json({ ok: true, action })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
