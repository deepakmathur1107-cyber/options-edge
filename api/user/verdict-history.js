// api/user/verdict-history.js
// GET /api/user/verdict-history?tradeId=<uuid>
//   -> { history: [...] }  -- verdict_checks rows for that trade, newest first
//
// Read-only. Ownership-checked: only returns history for a trade_id that
// belongs to the requesting clerk_user_id -- same pattern as
// api/user/trades.js's own DELETE/PUT handlers (.eq('clerk_user_id', clerkId)
// alongside .eq('id', id)), so one user can't fetch another user's trade
// history just by guessing/incrementing a UUID.

const { createClient } = require('@supabase/supabase-js')
const { getAuth } = require('../_lib/auth')

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { clerkId, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })

  const tradeId = req.query.tradeId
  if (!tradeId) return res.status(400).json({ error: 'Missing ?tradeId=' })

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Ownership check FIRST, as its own query -- not just relying on a join,
  // so a trade_id belonging to another user returns a clean 404 rather than
  // an empty array indistinguishable from "no history yet."
  const { data: trade, error: tradeErr } = await supabase
    .from('trades')
    .select('id')
    .eq('id', tradeId)
    .eq('clerk_user_id', clerkId)
    .maybeSingle()

  if (tradeErr) return res.status(500).json({ error: tradeErr.message })
  if (!trade) return res.status(404).json({ error: 'Trade not found' })

  const { data: history, error: historyErr } = await supabase
    .from('verdict_checks')
    .select('checked_at, current_score, entry_score, score_delta, current_mid, flagged, flag_reasons')
    .eq('trade_id', tradeId)
    .order('checked_at', { ascending: false })
    .limit(50)

  if (historyErr) return res.status(500).json({ error: historyErr.message })

  return res.status(200).json({ history: history || [] })
}
