// api/cron/resolve-trade-outcomes.js
//
// Item 2 (final design) — autonomous outcome resolution for logged PAPER
// TRADES, feeding the admin/app-wide aggregate P/L track record. Writes to
// trade_outcomes (NEW, separate table — see migration-create-trade-outcomes.sql
// for why this isn't signal_history or trade_close_suggestions).
//
// IMPORTANT — this is intentionally autonomous (resolves on its own, no
// user confirmation), unlike trade_close_suggestions (suggest-only, built
// earlier this session) and unlike trades.status itself (stays manual/
// suggest-only per explicit session decision). This file feeds a SEPARATE
// aggregate stat, not the user's own personal trade log. See session
// design discussion: "keep suggest-only for the user's personal trade, but
// separately build an admin-only, fully-autonomous parallel tracker."
//
// Core walk logic (findFirstThresholdHit, the daily-bar-then-1-min-bar
// two-step check, same-bar tie-break, retry/dead-letter pattern) is
// ADAPTED FROM resolve-outcomes.js, not rewritten from scratch — that
// logic is already proven (empirically verified against 603 real bars
// before it was written) and the underlying question ("did this contract's
// price cross a threshold between entry and expiry") is identical for a
// signal_history row and a trades row. Two real structural differences
// required adaptation, not a straight copy:
//   1. trades.target_price/stop_price are ABSOLUTE dollar values already
//      (set at logging time, confirmed via pushToJournal's parsePrice
//      output) — NOT a profit_target_pct/stop_loss_pct to multiply against
//      entry_mid, unlike signal_history's schema.
//   2. trades has no scanned_at column. created_at (when the user logged
//      the trade) is the walk-start anchor instead.
//   3. trades.expiration is NOT guaranteed to be a clean ISO date for
//      trades logged before this session's expiry_raw fix (confirmed:
//      older rows still show "Jul 2, 2026"-style strings). buildOccSymbol
//      already defensively handles either format internally (checked
//      earlier this session), so this file doesn't need its own special
//      case for that — but a trade with an unparseable expiration will
//      simply produce a garbage OCC symbol and resolve to no_quote/
//      data_unavailable via the existing retry path, same as it does for
//      verdict-check.js today. Not re-solved here; same known, accepted
//      limitation as everywhere else this session that touches old rows.

const { newRateTracker, logRateSummary, getOptionHistory, getOptionTimesales } = require('../_lib/tradierClient')
const { buildOccSymbol } = require('../_lib/occSymbol')
const { tradingDaysBetween } = require('../_lib/marketCalendar')

const CRON_SECRET = process.env.CRON_SECRET || ''
const MAX_RETRIES = 5

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[cron/resolve-trade-outcomes] supabase init failed:', e.message) }
  }
  return _sb
}

// Identical to resolve-outcomes.js's same-named function — the question
// being answered (did a bar cross target or stop first) doesn't change
// based on which table the price levels came from. Not duplicated by
// mistake; duplicated deliberately so this file has no import-time
// dependency on resolve-outcomes.js ever staying stable, given the two
// files now serve genuinely different tables/audiences (see header).
function findFirstThresholdHit(bars, targetPrice, stopPrice) {
  for (const bar of bars) {
    const hitTarget = bar.high >= targetPrice
    const hitStop   = bar.low  <= stopPrice
    if (hitTarget && hitStop) {
      return { type: 'same_bar_tiebreak', outcome: 'LOSS', at: bar.time }
    }
    if (hitTarget) return { type: 'target_hit', outcome: 'WIN', at: bar.time }
    if (hitStop)   return { type: 'stop_hit',   outcome: 'LOSS', at: bar.time }
  }
  return null
}

// Resolves a single trades row (already filtered to status='Open' with
// non-null target_price/stop_price by the caller's query). Returns a
// trade_outcomes upsert payload, or a control-flow marker object
// (_stillOpen / _noUsableData), same shape/meaning as resolve-outcomes.js's
// resolveOne for consistency.
async function resolveOne(trade, rateTracker) {
  const occSymbol = buildOccSymbol(trade.ticker, trade.option_type, trade.strike, trade.expiration)
  const entryMid = parseFloat(trade.entry_price)
  // DIFFERENCE FROM resolve-outcomes.js: these are read directly, not
  // computed from entryMid * (1 +/- pct) — see header comment point 1.
  const targetPrice = parseFloat(trade.target_price)
  const stopPrice = parseFloat(trade.stop_price)

  const loggedDate = new Date(trade.created_at)
  const expiryDate = new Date(trade.expiration + 'T12:00:00')
  const today = new Date()

  const walkEnd = today < expiryDate ? today : expiryDate
  const startDay = new Date(loggedDate); startDay.setDate(startDay.getDate() + 1)
  const days = tradingDaysBetween(startDay, walkEnd)

  for (const day of days) {
    const dailyBars = await getOptionHistory(occSymbol, day, day, rateTracker)
    const dailyBar = dailyBars[0]
    if (!dailyBar) continue
    const couldHaveCrossed = dailyBar.high >= targetPrice || dailyBar.low <= stopPrice
    if (!couldHaveCrossed) continue

    const bars = await getOptionTimesales(occSymbol, `${day} 09:30`, `${day} 16:00`, rateTracker)
    if (bars.length === 0) {
      console.warn(`[resolve-trade-outcomes] ${occSymbol} ${day}: daily bar suggested a threshold cross but timesales returned 0 bars`)
      continue
    }
    const hit = findFirstThresholdHit(bars, targetPrice, stopPrice)
    if (hit) {
      return {
        outcome: hit.outcome,
        hit_target_at: hit.outcome === 'WIN' ? hit.at : null,
        hit_stop_at: hit.outcome === 'LOSS' ? hit.at : null,
        resolved_at: new Date().toISOString(),
        resolution_method: hit.type,
      }
    }
  }

  if (today < expiryDate) {
    return { _stillOpen: true }
  }

  // Past expiry, no threshold ever crossed -> terminal expired state.
  // EXPIRED_FLAT (pnl <= 0, no hard stop hit) is exactly the theta-decay
  // case discussed with you directly this session: there's no separate
  // "decay loss" category by market convention (theta decay is continuous,
  // not a discrete threshold event — confirmed via research before this
  // file was written, not assumed) — EXPIRED_FLAT already correctly
  // represents "decayed to a loss without hitting a hard stop," same
  // logic resolve-outcomes.js already uses for signal_history.
  const lastTradingDay = days[days.length - 1] || null
  const closeBars = lastTradingDay ? await getOptionHistory(occSymbol, lastTradingDay, lastTradingDay, rateTracker) : []
  const exitMid = closeBars[0]?.close ?? null

  if (exitMid === null) {
    return { _noUsableData: true }
  }

  const pnlPct = (exitMid - entryMid) / entryMid
  return {
    outcome: pnlPct > 0 ? 'EXPIRED_PARTIAL' : 'EXPIRED_FLAT',
    exit_mid_at_expiry: exitMid,
    pnl_pct_at_expiry: pnlPct,
    resolved_at: new Date().toISOString(),
    resolution_method: pnlPct > 0 ? 'expired_partial' : 'expired_flat',
  }
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
                     || req.headers['x-vercel-cron'] === '1'
  const isManualTrigger = req.query.secret && req.query.secret === CRON_SECRET
  if (!isVercelCron && !isManualTrigger && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized — cron secret missing/invalid' })
  }

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  const startedAt = Date.now()
  const MAX_MS = 280_000
  const rateTracker = newRateTracker()

  // Only trades that are: open, have both target/stop set (the existing
  // "skip honestly, never guess" precondition this session established
  // for verdictCheck.js — reused identically here, not a new rule), and
  // don't already have a trade_outcomes row.
  //
  // Implemented as TWO simple queries + a JS diff, rather than a single
  // nested-select anti-join (e.g. trades.select('...,trade_outcomes(trade_id)')
  // then filtering for an empty array). Considered that approach first, but
  // couldn't directly confirm PostgREST's embedding-null-filter behavior
  // matches this exact shape without a live test against this schema —
  // two queries that are individually trivial to verify are worth the
  // extra round trip over one query whose correctness depends on embedding
  // semantics this file's author hadn't personally confirmed for this case.
  const BATCH_LIMIT = parseInt(req.query.limit, 10) || 50
  const { data: candidateTrades, error: fetchErr } = await client
    .from('trades')
    .select('id, ticker, option_type, strike, expiration, entry_price, target_price, stop_price, created_at')
    .eq('status', 'Open')
    .not('target_price', 'is', null)
    .not('stop_price', 'is', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) {
    console.error('[resolve-trade-outcomes] fetch failed:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }

  if (!candidateTrades || candidateTrades.length === 0) {
    return res.status(200).json({
      checked: 0, resolved: 0, stillOpen: 0, dataUnavailable: 0, errors: 0,
      durationMs: Date.now() - startedAt,
      rateHealth: { tradierCalls: 0, statusCounts: {}, minAvailable: null, throttled429: false },
      results: [],
    })
  }

  const { data: alreadyResolved, error: resolvedFetchErr } = await client
    .from('trade_outcomes')
    .select('trade_id')
    .in('trade_id', candidateTrades.map(t => t.id))

  if (resolvedFetchErr) {
    console.error('[resolve-trade-outcomes] resolved-set fetch failed:', resolvedFetchErr.message)
    return res.status(500).json({ error: resolvedFetchErr.message })
  }

  const resolvedIds = new Set((alreadyResolved || []).map(r => r.trade_id))
  const rows = (candidateTrades || []).filter(t => !resolvedIds.has(t.id))

  let resolved = 0, stillOpen = 0, dataUnavailable = 0, errors = 0
  const results = []

  for (const trade of rows) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[resolve-trade-outcomes] time budget reached, stopping early this run')
      break
    }
    try {
      const update = await resolveOne(trade, rateTracker)
      if (update._stillOpen) { stillOpen++; continue }

      if (update._noUsableData) {
        // Need the CURRENT attempt count -- query existing trade_outcomes
        // row if one exists from a prior _noUsableData pass (resolve_attempts
        // lives there, not on trades, since trade_outcomes is the only
        // place this resolver writes).
        const { data: existing } = await client
          .from('trade_outcomes')
          .select('resolve_attempts')
          .eq('trade_id', trade.id)
          .maybeSingle()
        const attempts = (existing?.resolve_attempts || 0) + 1
        const payload = attempts >= MAX_RETRIES
          ? { trade_id: trade.id, resolve_attempts: attempts, resolution_method: 'data_unavailable', resolved_at: new Date().toISOString() }
          : { trade_id: trade.id, resolve_attempts: attempts }
        const { error } = await client.from('trade_outcomes').upsert(payload, { onConflict: 'trade_id' })
        if (error) console.error(`[resolve-trade-outcomes] failed to upsert attempt-count for trade ${trade.id}:`, error.message)
        if (attempts >= MAX_RETRIES) dataUnavailable++; else stillOpen++
        continue
      }

      const { error } = await client.from('trade_outcomes').upsert({ trade_id: trade.id, ...update }, { onConflict: 'trade_id' })
      if (error) {
        errors++
        console.error(`[resolve-trade-outcomes] upsert failed for trade ${trade.id} (${trade.ticker}):`, error.message)
      } else {
        resolved++
        results.push({ tradeId: trade.id, ticker: trade.ticker, outcome: update.outcome })
      }
    } catch (e) {
      errors++
      console.error(`[resolve-trade-outcomes] unhandled error for trade ${trade.id} (${trade.ticker}):`, e.message)
    }
  }

  const durationMs = Date.now() - startedAt
  logRateSummary('resolve-trade-outcomes', rateTracker, durationMs)

  return res.status(200).json({
    checked: rows.length,
    resolved, stillOpen, dataUnavailable, errors,
    durationMs,
    rateHealth: {
      tradierCalls: rateTracker.calls,
      statusCounts: rateTracker.statusCounts,
      minAvailable: rateTracker.minAvailable,
      throttled429: (rateTracker.statusCounts[429] || 0) > 0,
    },
    results,
  })
}
