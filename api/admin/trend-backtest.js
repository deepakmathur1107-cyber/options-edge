// api/admin/trend-backtest.js
// Added 2026-07-18. Backfills long_term_trend (SMA50/SMA200, as-of the
// row's ACTUAL entry date) onto historical resolved signal_history rows —
// the same column live scans now populate going forward (see scan.js +
// trendContext.js). This lets one SQL query directly answer "what would the
// blended win rate have looked like if counter-trend Swing/LEAP/Deep LEAP
// trades had been filtered out" — see README section below for the exact
// query and, importantly, what this number does and doesn't mean.
//
// HONEST FRAMING, worth repeating in code since it's easy to misread the
// output: this CANNOT retroactively turn a LOSS into a WIN. The market did
// what it did. What this DOES let you compute is a real counterfactual:
// among trades that were NOT counter-trend (or where trend was unknown/mixed
// and no dampening would apply), what was the actual win rate? That's the
// legitimate "if we'd been filtering this way, this is the win rate we'd
// have been reporting" number — filtering changes what gets shown/sized,
// not what happened to the trades that stayed in.
//
// Uses the SAME getTrendContext function live scans use, just with asOfDate
// set to each row's historical scanned_at date instead of "today" — the
// underlying SMA50/SMA200 math is identical, only the reference date differs.

const { newRateTracker, logRateSummary, getOptionHistory } = require('../_lib/tradierClient')
const { getTrendContext } = require('../_lib/trendContext')

const CRON_SECRET = process.env.CRON_SECRET || ''

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[trend-backtest] supabase init failed:', e.message) }
  }
  return _sb
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
  const isManualTrigger = req.query.secret && req.query.secret === CRON_SECRET
  if (!isVercelCron && !isManualTrigger && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized — cron secret missing/invalid' })
  }

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  const startedAt = Date.now()
  const MAX_MS = 280_000
  const BATCH_LIMIT = parseInt(req.query.limit, 10) || 100
  const rateTracker = newRateTracker()

  // Circuit breaker — same pattern as resolve-outcomes.js's fix, same
  // rationale: don't burn the whole batch's Tradier budget silently
  // accomplishing nothing if the API is degraded mid-run.
  let circuitBroken = false

  // Only backfill rows that are: resolved (real outcome to compare against),
  // Quick/Swing (the only timeframes with real sample size right now — LEAP/
  // Deep LEAP have too few resolved rows to draw anything from yet), and not
  // already backfilled (long_term_trend IS NULL) — makes this resumable
  // across multiple runs, same as the resolver's batch pattern.
  const { data: rows, error: fetchErr } = await client
    .from('signal_history')
    .select('id, ticker, scanned_at, option_type, timeframe, outcome')
    .eq('is_lifecycle_primary', true)
    .not('outcome', 'is', null)
    .neq('outcome', 'AMBIGUOUS')
    .is('long_term_trend', null)
    .in('timeframe', ['Quick (5–14 DTE)', 'Swing (21–45 DTE)'])
    .order('scanned_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) {
    console.error('[trend-backtest] fetch failed:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }
  if (!rows || !rows.length) {
    return res.status(200).json({ checked: 0, backfilled: 0, message: 'Nothing left to backfill — all resolved Quick/Swing rows already have long_term_trend.' })
  }

  let backfilled = 0, errors = 0

  for (const row of rows) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[trend-backtest] time budget reached, stopping early this run')
      break
    }
    if (rateTracker.calls >= 50) {
      const okCount = rateTracker.statusCounts[200] || 0
      const failureRate = 1 - (okCount / rateTracker.calls)
      if (failureRate > 0.25) {
        console.warn(`[trend-backtest] ⚠️ CIRCUIT BREAKER — stopping early: ${rateTracker.calls} calls, ${Math.round(failureRate * 100)}% non-200`)
        circuitBroken = true
        break
      }
    }

    try {
      const asOfDate = row.scanned_at.slice(0, 10) // 'YYYY-MM-DD'
      const trend = await getTrendContext(row.ticker, asOfDate, getOptionHistory, rateTracker)
      const { error: updateErr } = await client
        .from('signal_history')
        .update({ long_term_trend: trend.direction })
        .eq('id', row.id)
      if (updateErr) {
        console.error(`[trend-backtest] update failed id=${row.id}:`, updateErr.message)
        errors++
      } else {
        backfilled++
      }
    } catch (e) {
      console.error(`[trend-backtest] ${row.ticker} failed:`, e.message)
      errors++
    }
  }

  const durationMs = Date.now() - startedAt
  logRateSummary('trend-backtest', rateTracker, durationMs)

  return res.status(200).json({
    checked: rows.length,
    backfilled, errors, circuitBroken,
    durationMs,
    rateHealth: {
      tradierCalls: rateTracker.calls,
      statusCounts: rateTracker.statusCounts,
      minAvailable: rateTracker.minAvailable,
    },
    note: 'Once backfilled, query win rate split by counter-trend status directly — see DEPLOY_README.md for the exact SQL.',
  })
}
