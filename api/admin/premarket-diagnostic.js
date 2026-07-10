// api/admin/premarket-diagnostic.js
//
// Purpose: answer the open question from the 2026-07-09 CRM $165P gap
// session — does Tradier's /markets/quotes response reflect real premarket
// trade prints, or does it sit stale at the prior session's close until
// regular trading begins at 13:30 UTC?
//
// This is NOT meant to run continuously or be wired into any cron. It's a
// one-shot manual tool: hit it during an actual premarket window (ideally
// on a real gap morning — a known earnings reaction is the clearest test)
// and read the raw fields directly rather than trusting any derived
// "is this stale" heuristic below blindly. The heuristic is a starting
// point for a quick read, not a substitute for looking at the actual
// trade_date/last/bid/ask values yourself.
//
// Usage: GET /api/admin/premarket-diagnostic?symbols=AAPL,TSLA,CRM
// (defaults to a small liquid basket if no symbols param is given, since
// low-volume names are more likely to show stale premarket data regardless
// of whether Tradier supports it — testing on liquid names first isolates
// "does Tradier have this at all" from "does this specific illiquid name
// have premarket prints right now.")
//
// Read-only. Makes exactly one Tradier call per request, admin-gated,
// same auth pattern as every other admin endpoint.

const { getAuth, ADMIN_IDS } = require('../_lib/auth')
const { TRADIER_TOKEN, TRADIER_BASE } = require('../_lib/tradierClient')

const DEFAULT_SYMBOLS = ['AAPL', 'TSLA', 'SPY', 'QQQ']

// Regular session (ET): 9:30am-4:00pm. Premarket: roughly 4:00am-9:30am.
// This is only used to label what session we THINK it is right now, for
// readability in the response — it does not change what gets fetched.
function classifySessionET() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const hours = nowET.getHours() + nowET.getMinutes() / 60
  const day = nowET.getDay()
  if (day === 0 || day === 6) return 'weekend'
  if (hours < 4)    return 'closed (overnight)'
  if (hours < 9.5)  return 'premarket'
  if (hours < 16)   return 'regular session'
  if (hours < 20)   return 'postmarket'
  return 'closed (overnight)'
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { clerkId, isAdmin, error: authErr } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: authErr || 'Unauthorized' })
  if (!isAdmin && !ADMIN_IDS.includes(clerkId)) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  const symbolsParam = (req.query.symbols || '').toString().trim()
  const symbols = symbolsParam ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_SYMBOLS

  const nowUTC = new Date()
  const sessionGuess = classifySessionET()

  try {
    const url = `${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(symbols.join(','))}&greeks=false`
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
    })
    const raw = await resp.json()
    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Tradier request failed', raw })
    }

    let quotes = raw?.quotes?.quote
    if (!quotes) quotes = []
    if (!Array.isArray(quotes)) quotes = [quotes]   // known single-result XML->JSON quirk

    const diagnostics = quotes.map(q => {
      // trade_date is typically an epoch-ms timestamp of the last print.
      // Comparing it to "now" tells us whether this quote is fresh (a real
      // premarket trade just happened) or stale (sitting at the prior
      // session's last regular-hours print). This is a rough signal only —
      // read the actual minutesSinceLastTrade value yourself, don't just
      // trust the label.
      const tradeDateMs = Number(q.trade_date) || null
      const minutesSinceLastTrade = tradeDateMs ? Math.round((nowUTC.getTime() - tradeDateMs) / 60000) : null
      return {
        symbol: q.symbol,
        last: q.last,
        bid: q.bid,
        ask: q.ask,
        volume: q.volume,
        change_percentage: q.change_percentage,
        prevclose: q.prevclose,
        trade_date_raw: q.trade_date,
        trade_date_iso: tradeDateMs ? new Date(tradeDateMs).toISOString() : null,
        minutes_since_last_trade: minutesSinceLastTrade,
        // Rough read, not a verdict: if we're in the premarket window per
        // the ET clock above AND the last trade is >20 min stale, that's
        // suggestive (not proof) the quote hasn't picked up fresh
        // premarket activity for this symbol at this moment.
        looks_stale_for_premarket: sessionGuess === 'premarket' && minutesSinceLastTrade !== null && minutesSinceLastTrade > 20,
      }
    })

    return res.status(200).json({
      checked_at_utc: nowUTC.toISOString(),
      session_guess_et: sessionGuess,
      note: 'session_guess_et is informational only, based on server clock — verify independently if it matters for your read of the result.',
      symbols_checked: symbols,
      diagnostics,
      raw_tradier_response: raw,
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
