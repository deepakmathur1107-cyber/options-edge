// api/admin/shadow-spread-resolver.js
// Added 2026-07-20. Phase 1b of the re-architecture roadmap: resolves
// shadow vertical spreads (Phase 1) so their expectancy can eventually be
// compared against the live single-leg signal's real resolved outcomes.
//
// DESIGN CHOICE, stated plainly: this resolves at EXPIRATION SETTLEMENT
// ONLY, not an early target/stop walk the way the single-leg resolver does.
// Reasoning:
//   1. A full day-by-day mark-to-market walk would require BOTH legs' prices
//      at every step, doubling the walk complexity and re-exposing the same
//      10-day options-intraday retention problem that took multiple fixes
//      to handle for singles (see resolve-outcomes.js history).
//   2. Settlement value needs only the UNDERLYING STOCK's price at one point
//      in time (expiry date) — stock daily history has no retention limit
//      (confirmed repeatedly this week), so this sidesteps that entire bug
//      class rather than re-fighting it.
//   3. Honest tradeoff: this does NOT model exiting early at, say, 50% of
//      max profit (common real vertical-spread trading practice) — it's a
//      worst-case, hold-to-expiry comparison. Real spread trading would very
//      likely do better than what this resolver reports. Treat these numbers
//      as a FLOOR on spread expectancy, not the ceiling.
//
// Settlement math: intrinsic value at expiry, clamped to [0, spread_width]
// (a debit vertical can never be worth less than 0 or more than its width):
//   call spread: clamp(settlementPrice - long_strike, 0, width)
//   put  spread: clamp(long_strike - settlementPrice, 0, width)
// pnl_pct = (intrinsicValue - netDebit) / netDebit — return on debit risked,
// directly comparable to the shortened-hold-backtest's pnl_pct convention.

const { newRateTracker, logRateSummary, getOptionHistory } = require('../_lib/tradierClient')

const CRON_SECRET = process.env.CRON_SECRET || ''

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[shadow-spread-resolver] supabase init failed:', e.message) }
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
  let circuitBroken = false

  const todayStr = new Date().toISOString().slice(0, 10)

  // Only rows where the shadow spread exists, hasn't been resolved yet, AND
  // has actually reached expiry — resolving before expiry would mean
  // guessing at an interim mark-to-market value, which is exactly the
  // early-exit complexity this design deliberately avoids for Phase 1b.
  const { data: rows, error: fetchErr } = await client
    .from('signal_history')
    .select('id, ticker, expiry_raw, option_type, shadow_vertical_spread')
    .not('shadow_vertical_spread', 'is', null)
    .is('shadow_spread_pnl_pct', null)
    .lt('expiry_raw', todayStr)
    .order('expiry_raw', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) {
    console.error('[shadow-spread-resolver] fetch failed:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }
  if (!rows || !rows.length) {
    return res.status(200).json({ checked: 0, resolved: 0, message: 'Nothing left to resolve — no shadow spreads have reached expiry yet, or all expired ones are already resolved.' })
  }

  let resolved = 0, errors = 0

  for (const row of rows) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[shadow-spread-resolver] time budget reached, stopping early this run')
      break
    }
    if (rateTracker.calls >= 50) {
      const okCount = rateTracker.statusCounts[200] || 0
      const failureRate = 1 - (okCount / rateTracker.calls)
      if (failureRate > 0.25) {
        console.warn(`[shadow-spread-resolver] ⚠️ CIRCUIT BREAKER — stopping early: ${rateTracker.calls} calls, ${Math.round(failureRate * 100)}% non-200`)
        circuitBroken = true
        break
      }
    }

    try {
      const spread = row.shadow_vertical_spread
      const expiry = new Date(row.expiry_raw + 'T12:00:00')
      const rangeStart = new Date(expiry); rangeStart.setDate(rangeStart.getDate() - 3)
      const rangeEnd   = new Date(expiry); rangeEnd.setDate(rangeEnd.getDate() + 1) // expiry itself, plus 1 day buffer for settlement lag
      const bars = await getOptionHistory(row.ticker, rangeStart.toISOString().slice(0,10), rangeEnd.toISOString().slice(0,10), rateTracker)

      let outcome, pnlPct
      if (!bars.length) {
        outcome = 'unknown'
        pnlPct = null
      } else {
        // Closest bar to the actual expiry date, not just the last one in range.
        const target = expiry.getTime()
        const closest = bars.reduce((best, b) => {
          const bt = new Date(b.date || target).getTime()
          const bestT = new Date(best.date || target).getTime()
          return Math.abs(bt - target) < Math.abs(bestT - target) ? b : best
        }, bars[0])
        const settlementPrice = closest.close
        if (typeof settlementPrice !== 'number') {
          outcome = 'unknown'
          pnlPct = null
        } else {
          const width = spread.spread_width
          const netDebit = spread.net_debit
          const rawIntrinsic = row.option_type === 'call'
            ? settlementPrice - spread.long_strike
            : spread.long_strike - settlementPrice
          const intrinsicValue = Math.max(0, Math.min(width, rawIntrinsic))
          pnlPct = Math.round(((intrinsicValue - netDebit) / netDebit) * 10000) / 100
          if (intrinsicValue >= width) outcome = 'FULL_WIN'
          else if (intrinsicValue <= 0) outcome = 'TOTAL_LOSS'
          else outcome = 'PARTIAL'
        }
      }

      const { error: updateErr } = await client
        .from('signal_history')
        .update({ shadow_spread_outcome: outcome, shadow_spread_pnl_pct: pnlPct })
        .eq('id', row.id)
      if (updateErr) {
        console.error(`[shadow-spread-resolver] update failed id=${row.id}:`, updateErr.message)
        errors++
      } else {
        resolved++
      }
    } catch (e) {
      console.error(`[shadow-spread-resolver] ${row.ticker} failed:`, e.message)
      errors++
    }
  }

  const durationMs = Date.now() - startedAt
  logRateSummary('shadow-spread-resolver', rateTracker, durationMs)

  return res.status(200).json({
    checked: rows.length,
    resolved, errors, circuitBroken,
    durationMs,
    rateHealth: {
      tradierCalls: rateTracker.calls,
      statusCounts: rateTracker.statusCounts,
      minAvailable: rateTracker.minAvailable,
    },
  })
}
