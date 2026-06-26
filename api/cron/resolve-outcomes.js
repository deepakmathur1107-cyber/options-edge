// api/cron/resolve-outcomes.js
//
// Phase 2 — outcome resolver. Walks every unresolved row in signal_history
// (outcome IS NULL) forward through real trading days, checking each day's
// price action against that signal's profit-target and stop-loss levels,
// using Tradier's markets/history (daily, cheap pre-check) and
// markets/timesales (1-min bars, real resolution) — see
// phase2-outcome-resolver-spec.md for the full design and edge-case list
// this implements.
//
// Runs on its own cron schedule, OFFSET from the scan crons (which run
// */15 10-22 UTC Mon-Fri) — see vercel.json. This avoids contending with the
// scan cron for the shared 120 req/min Tradier rate limit (see resolver spec
// §7 and the rate-check warnings already proven out in cron/scan.js).
//
// Empirically verified before this file was written (live curl tests,
// June 2026): same-bar target/stop collisions occurred in 0 of 603 sample
// bars across 5 real signals — the same-bar tie-break rule below is a rare-
// case safety net, not a load-bearing assumption. See spec §6.

const { newRateTracker, logRateSummary, getOptionHistory, getOptionTimesales } = require('../_lib/tradierClient')
const { buildOccSymbol } = require('../_lib/occSymbol')
const { tradingDaysBetween } = require('../_lib/marketCalendar')

const CRON_SECRET = process.env.CRON_SECRET || ''
const MAX_RETRIES = 5   // cap on resolution attempts before dead-lettering a row (spec §5)

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[cron/resolve-outcomes] supabase init failed:', e.message) }
  }
  return _sb
}

// Walks one day's 1-min bars in chronological order, looking for the first
// bar that crosses either threshold. Returns the terminal event for that day,
// or null if neither threshold was crossed.
//
// Same-bar handling (spec §6): if a single bar's high/low crosses BOTH
// thresholds, this is logged as a tie and resolved conservatively as a LOSS
// (resolution_method: 'same_bar_tiebreak') rather than guessed in either
// direction. Empirically rare (0/603 in pre-build sampling) — if this fires
// often in production, that sampling assumption needs revisiting, which is
// exactly why resolution_method records it distinctly rather than silently
// folding it into ordinary stop-loss counts.
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

// Resolves a single signal_history row. Returns a Supabase update payload,
// or null if the row should be left untouched this run (still genuinely
// unresolved, no error).
async function resolveOne(row, rateTracker) {
  const occSymbol = buildOccSymbol(row.ticker, row.option_type, row.primary_strike, row.expiry_raw)
  const entryMid    = parseFloat(row.entry_mid)
  const targetPrice = entryMid * (1 + parseFloat(row.profit_target_pct))
  const stopPrice   = entryMid * (1 - parseFloat(row.stop_loss_pct))

  const scannedDate = new Date(row.scanned_at)
  const expiryDate  = new Date(row.expiry_raw + 'T12:00:00')
  const today       = new Date()

  // Walk forward from the day AFTER scanned_at (entry day's own intraday
  // movement after the scan moment isn't re-checked — entry_mid IS that
  // moment's price, so by definition neither threshold could have already
  // been crossed before it was recorded) through either today or expiry,
  // whichever is earlier.
  const walkEnd = today < expiryDate ? today : expiryDate
  const startDay = new Date(scannedDate); startDay.setDate(startDay.getDate() + 1)
  const days = tradingDaysBetween(startDay, walkEnd)

  for (const day of days) {
    // Step 1 — cheap pre-check via daily history. Skip the 1-min pull
    // entirely if neither threshold could possibly have been crossed that
    // day (spec §4 step 1).
    const dailyBars = await getOptionHistory(occSymbol, day, day, rateTracker)
    const dailyBar = dailyBars[0]
    if (!dailyBar) {
      // No data this specific day — could be a real gap (holiday miscount,
      // data lag) or an illiquid contract with zero prints that day. This is
      // NOT tracked per-day; a single missing day mid-walk is simply skipped
      // and the walk continues to the next trading day. resolve_attempts
      // (incremented by the caller) only fires if the ENTIRE walk for this
      // row completes with no terminal event AND no usable expiry-close
      // price — i.e. "this row never resolved this run," not "this one day
      // had no data."
      continue
    }
    const couldHaveCrossed = dailyBar.high >= targetPrice || dailyBar.low <= stopPrice
    if (!couldHaveCrossed) continue

    // Step 2 — real 1-min bars for this specific day only.
    const bars = await getOptionTimesales(occSymbol, `${day} 09:30`, `${day} 16:00`, rateTracker)
    if (bars.length === 0) {
      // Daily bar said it crossed a threshold but timesales returned nothing
      // for the same day — data inconsistency. Don't guess; treat as
      // unresolved-this-day and let the retry counter handle persistent
      // failures (spec §5, "no data ever returned").
      console.warn(`[resolve-outcomes] ${occSymbol} ${day}: daily bar suggested a threshold cross but timesales returned 0 bars`)
      continue
    }
    const hit = findFirstThresholdHit(bars, targetPrice, stopPrice)
    if (hit) {
      return {
        outcome: hit.outcome,
        hit_target_at: hit.outcome === 'WIN' ? hit.at : null,
        hit_stop_at:   hit.outcome === 'LOSS' ? hit.at : null,
        resolved_at: new Date().toISOString(),
        resolution_method: hit.type,
      }
    }
    // Daily bar's range suggested a cross but the 1-min walk didn't confirm
    // it — possible with Tradier's vwap/print-based highs/lows not aligning
    // perfectly between daily and intraday aggregation. Move on to the next
    // day rather than treat this as a hard error.
  }

  // No terminal event found in the walked range.
  if (today < expiryDate) {
    // Still open — genuinely unresolved, not an error. Leave outcome NULL,
    // bump the attempt counter so persistent data gaps still eventually
    // dead-letter (see caller).
    return { _stillOpen: true }
  }

  // Past expiry with no threshold ever crossed → terminal expired state
  // (spec §4 step 5). Use the last available daily close as exit price.
  // NOTE: if `days` is empty here (only possible if scanned_at and expiry_raw
  // are the same trading day, or expiry has already passed before the walk
  // ever ran), there's no day to pull a close from — that's the
  // data_unavailable path below, not a bug to paper over with a recomputed
  // range that would also come back empty for the same reason.
  const lastTradingDay = days[days.length - 1] || null
  const closeBars = lastTradingDay ? await getOptionHistory(occSymbol, lastTradingDay, lastTradingDay, rateTracker) : []
  const exitMid = closeBars[0]?.close ?? null

  if (exitMid === null) {
    // Expired and we never got a single usable price print for it. Don't
    // dead-letter on the first occurrence — pass the gap up to the caller,
    // which increments resolve_attempts and only marks data_unavailable
    // once MAX_RETRIES is exceeded (spec §5: "cap retries, then dead-letter").
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

  const BATCH_LIMIT = parseInt(req.query.limit, 10) || 50
  const { data: rows, error: fetchErr } = await client
    .from('signal_history')
    .select('*')
    .is('outcome', null)
    .order('scanned_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) {
    console.error('[resolve-outcomes] fetch failed:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }

  let resolved = 0, stillOpen = 0, dataUnavailable = 0, errors = 0
  const results = []

  for (const row of rows) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[resolve-outcomes] time budget reached, stopping early this run')
      break
    }
    try {
      const update = await resolveOne(row, rateTracker)
      if (update._stillOpen) { stillOpen++; continue }
      if (update._noUsableData) {
        const attempts = (row.resolve_attempts || 0) + 1
        if (attempts >= MAX_RETRIES) {
          dataUnavailable++
          const { error } = await client.from('signal_history')
            .update({
              resolve_attempts: attempts,
              resolution_method: 'data_unavailable',
              resolved_at: new Date().toISOString(),
            })
            .eq('id', row.id)
          if (error) console.error(`[resolve-outcomes] failed to dead-letter id=${row.id}:`, error.message)
        } else {
          stillOpen++
          const { error } = await client.from('signal_history')
            .update({ resolve_attempts: attempts })
            .eq('id', row.id)
          if (error) console.error(`[resolve-outcomes] failed to bump resolve_attempts for id=${row.id}:`, error.message)
        }
        continue
      }
      const { error } = await client.from('signal_history').update(update).eq('id', row.id)
      if (error) {
        errors++
        console.error(`[resolve-outcomes] update failed for id=${row.id} (${row.ticker}):`, error.message)
      } else {
        resolved++
        results.push({ id: row.id, ticker: row.ticker, outcome: update.outcome })
      }
    } catch (e) {
      errors++
      console.error(`[resolve-outcomes] unhandled error for id=${row.id} (${row.ticker}):`, e.message)
    }
  }

  const durationMs = Date.now() - startedAt
  logRateSummary('resolve-outcomes', rateTracker, durationMs)

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
