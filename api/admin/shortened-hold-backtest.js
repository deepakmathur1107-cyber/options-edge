// api/admin/shortened-hold-backtest.js
// Added 2026-07-18. Tests Direction B before committing to Direction A
// (mid-hold re-evaluation — bigger build) per Deepak's own sequencing.
//
// HYPOTHESIS: the win-rate investigation found a clean natural experiment —
// the SAME Swing entry cohort's put win rate roughly HALVED vs. the identical
// signals' Quick-duration performance, purely from being held longer
// (21-45 days vs. 5-14 days). The already-shipped entry-time trend filter
// (Direction A's simpler cousin) failed to explain this (full-dataset
// backtest: filtering counter-trend trades barely moved win rate, sometimes
// made it worse). Direction B asks a more basic question: does simply
// SHORTENING Swing's effective hold duration (independent of any directional
// filter) recover most of Quick's better duration-matched performance?
//
// METHOD: for each resolved Swing trade, check whether it already resolved
// (hit_stop_at/hit_target_at) within the first 14 calendar days of entry —
// if so, the shortened-hold outcome is identical to the actual outcome,
// no new data needed. If not, fetch the ACTUAL historical option price at
// the 14-day mark and simulate a forced exit there.
//
// STRICT DEFINITION CONSISTENCY: a forced exit at day 14 only counts as WIN
// if it happens to have already cleared the full profit target by then
// (rare, and this case is caught by the hit_target_at check above, not by
// this fallback path) — the fallback path is BY DEFINITION neither-hit-yet,
// so it is classified 'FLAT' regardless of P&L sign. This matches how
// EXPIRED_PARTIAL/EXPIRED_FLAT are already NOT counted as wins under the
// app's own strict track-record.js definition — keeps this comparable to
// every other win-rate number quoted this week, not a new, softer standard.

const { newRateTracker, logRateSummary, getOptionHistory } = require('../_lib/tradierClient')
const { buildOccSymbol } = require('../_lib/occSymbol')

const CRON_SECRET = process.env.CRON_SECRET || ''
const SHORTENED_HOLD_DAYS = 14 // matches Quick's upper DTE bound

// Swing's real target/stop, matching TF_CONFIG in scanLogic.js exactly —
// needed to assign an exact numeric P&L to WIN/LOSS cases (not just FLAT),
// so every row has a comparable number for the expected-value query.
const SWING_TARGET = 0.80
const SWING_STOP   = -0.50

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[shortened-hold-backtest] supabase init failed:', e.message) }
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

  const { data: rows, error: fetchErr } = await client
    .from('signal_history')
    .select('id, ticker, scanned_at, option_type, primary_strike, expiry_raw, entry_mid, outcome, hit_stop_at, hit_target_at')
    .eq('is_lifecycle_primary', true)
    .not('outcome', 'is', null)
    .neq('outcome', 'AMBIGUOUS')
    .is('shortened_hold_pnl_pct', null)
    .eq('timeframe', 'Swing (21–45 DTE)')
    .order('scanned_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) {
    console.error('[shortened-hold-backtest] fetch failed:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }
  if (!rows || !rows.length) {
    return res.status(200).json({ checked: 0, backfilled: 0, message: 'Nothing left to backfill — all resolved Swing rows already have shortened_hold_outcome.' })
  }

  let backfilled = 0, errors = 0

  for (const row of rows) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[shortened-hold-backtest] time budget reached, stopping early this run')
      break
    }
    if (rateTracker.calls >= 50) {
      const okCount = rateTracker.statusCounts[200] || 0
      const failureRate = 1 - (okCount / rateTracker.calls)
      if (failureRate > 0.25) {
        console.warn(`[shortened-hold-backtest] ⚠️ CIRCUIT BREAKER — stopping early: ${rateTracker.calls} calls, ${Math.round(failureRate * 100)}% non-200`)
        circuitBroken = true
        break
      }
    }

    try {
      const scannedAt = new Date(row.scanned_at)
      const cutoff = new Date(scannedAt)
      cutoff.setDate(cutoff.getDate() + SHORTENED_HOLD_DAYS)

      let shortenedOutcome, shortenedPnlPct
      if (row.hit_target_at && new Date(row.hit_target_at) <= cutoff) {
        shortenedOutcome = 'WIN'
        shortenedPnlPct = SWING_TARGET // exact +80%, matches how the real target-hit was defined
      } else if (row.hit_stop_at && new Date(row.hit_stop_at) <= cutoff) {
        shortenedOutcome = 'LOSS'
        shortenedPnlPct = SWING_STOP // exact -50%
      } else {
        // Neither hit within the shortened window (or no hit timestamp at
        // all — e.g. an expiry-fallback row) — simulate a forced exit at
        // the day-14 price. FLAT under the strict WIN-only definition
        // (matches EXPIRED_PARTIAL/FLAT treatment elsewhere), but the
        // NUMERIC pnl is what actually lets this row's real economic
        // outcome — including avoided-loss cases — show up in an expected-
        // value comparison, which a categorical label alone couldn't.
        const occSymbol = buildOccSymbol(row.ticker, row.option_type, row.primary_strike, row.expiry_raw)
        const cutoffStr = cutoff.toISOString().slice(0, 10)
        const rangeStart = new Date(cutoff); rangeStart.setDate(rangeStart.getDate() - 2)
        const rangeEnd   = new Date(cutoff); rangeEnd.setDate(rangeEnd.getDate() + 2)
        const bars = await getOptionHistory(occSymbol, rangeStart.toISOString().slice(0,10), rangeEnd.toISOString().slice(0,10), rateTracker)
        if (!bars.length) {
          shortenedOutcome = 'unknown'
          shortenedPnlPct = null
        } else {
          const target = cutoff.getTime()
          const closest = bars.reduce((best, b) => {
            const bt = new Date(b.date || b.time || cutoffStr).getTime()
            const bestT = new Date(best.date || best.time || cutoffStr).getTime()
            return Math.abs(bt - target) < Math.abs(bestT - target) ? b : best
          }, bars[0])
          if (typeof closest.close === 'number' && row.entry_mid) {
            shortenedOutcome = 'FLAT'
            shortenedPnlPct = (closest.close - row.entry_mid) / row.entry_mid
          } else {
            shortenedOutcome = 'unknown'
            shortenedPnlPct = null
          }
        }
      }

      const { error: updateErr } = await client
        .from('signal_history')
        .update({ shortened_hold_outcome: shortenedOutcome, shortened_hold_pnl_pct: shortenedPnlPct })
        .eq('id', row.id)
      if (updateErr) {
        console.error(`[shortened-hold-backtest] update failed id=${row.id}:`, updateErr.message)
        errors++
      } else {
        backfilled++
      }
    } catch (e) {
      console.error(`[shortened-hold-backtest] ${row.ticker} failed:`, e.message)
      errors++
    }
  }

  const durationMs = Date.now() - startedAt
  logRateSummary('shortened-hold-backtest', rateTracker, durationMs)

  return res.status(200).json({
    checked: rows.length,
    backfilled, errors, circuitBroken,
    durationMs,
    rateHealth: {
      tradierCalls: rateTracker.calls,
      statusCounts: rateTracker.statusCounts,
      minAvailable: rateTracker.minAvailable,
    },
  })
}
