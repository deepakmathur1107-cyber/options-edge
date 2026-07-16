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

// Tradier's /markets/timesales retains 1-min bars for only ~10 calendar days
// (confirmed against Tradier docs, 2026-07). Any crossing day older than this
// can NEVER be confirmed at 1-min resolution again — the data is gone. The
// original resolver assumed timesales was durably available whenever we got
// around to it; it isn't. We use a conservative 9-day cutoff (one day of
// safety margin under the documented 10) to decide when to stop attempting
// intraday confirmation and fall back to daily-bar-only resolution.
const TIMESALES_RETENTION_DAYS = 9

function daysAgo(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
}

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

// Looks up the UNDERLYING stock's closing price on the resolution day, so we
// can natively record the entry-vs-exit stock move (distinguishing a genuine
// wrong-direction loss from a theta/IV-decay loss). Uses /markets/history for
// the plain ticker — that endpoint covers a stock's full lifetime, so unlike
// option timesales this works for aged-out rows too. Returns null on any
// failure; underlying_price_at_resolution is nullable and NULL honestly means
// "couldn't capture" rather than a fabricated number.
async function getUnderlyingCloseOn(ticker, day, rateTracker) {
  if (!day) return null
  try {
    const bars = await getOptionHistory(ticker, day, day, rateTracker) // symbol-agnostic /markets/history
    const close = bars[0]?.close
    return (typeof close === 'number' && !isNaN(close)) ? close : null
  } catch {
    return null
  }
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

  // Tracks whether the walk hit a crossing day that we COULD have confirmed
  // at 1-min but timesales came back empty (real inconsistency, worth
  // retrying) vs. a crossing day already past the retention window (never
  // retryable — must go to daily-bar fallback). These drive different caller
  // behavior: the former bumps the retry counter, the latter goes straight
  // to fallback resolution rather than pretending a future retry might help.
  let sawUnconfirmableRecentCrossing = false

  for (const day of days) {
    // Step 1 — cheap pre-check via daily history. Skip the 1-min pull
    // entirely if neither threshold could possibly have been crossed that
    // day (spec §4 step 1).
    const dailyBars = await getOptionHistory(occSymbol, day, day, rateTracker)
    const dailyBar = dailyBars[0]
    if (!dailyBar) {
      // No data this specific day — see note below; single missing day is
      // skipped, walk continues.
      continue
    }
    const couldHaveCrossed = dailyBar.high >= targetPrice || dailyBar.low <= stopPrice
    if (!couldHaveCrossed) continue

    // A crossing is indicated. Decide HOW to confirm based on the day's age.
    const ageDays = daysAgo(day)

    if (ageDays > TIMESALES_RETENTION_DAYS) {
      // Intraday data for this day is permanently gone. Do NOT burn a
      // timesales call that we know will return nothing. Resolve from the
      // daily bar alone, recording the reduced confidence explicitly so
      // win-rate analysis can weight/segment these separately from
      // intraday-confirmed results.
      const dHitTarget = dailyBar.high >= targetPrice
      const dHitStop   = dailyBar.low  <= stopPrice

      if (dHitTarget && dHitStop) {
        // Both barriers within one DAILY bar (up to 6.5h apart, unknown
        // order). We have zero information on sequence — forcing a LOSS here
        // would fabricate a directional result and systematically depress
        // win rate on exactly the highest-volatility days (widest range =
        // most likely to span both). Mark ambiguous, exclude from win-rate.
        return {
          outcome: 'AMBIGUOUS',
          resolved_at: new Date().toISOString(),
          resolution_method: 'daily_bar_both_crossed_ambiguous',
          _resolvedDay: day,
        }
      }
      if (dHitTarget) {
        return {
          outcome: 'WIN',
          hit_target_at: `${day}T00:00:00Z`, // day-level only; no intraday timestamp available
          resolved_at: new Date().toISOString(),
          resolution_method: 'daily_bar_fallback_target',
          _resolvedDay: day,
        }
      }
      // dHitStop
      return {
        outcome: 'LOSS',
        hit_stop_at: `${day}T00:00:00Z`,
        resolved_at: new Date().toISOString(),
        resolution_method: 'daily_bar_fallback_stop',
        _resolvedDay: day,
      }
    }

    // Recent enough — intraday confirmation is still possible. Step 2: real
    // 1-min bars for this specific day only.
    const bars = await getOptionTimesales(occSymbol, `${day} 09:30`, `${day} 16:00`, rateTracker)
    if (bars.length === 0) {
      // Daily bar said it crossed but timesales returned nothing, on a day
      // still INSIDE the retention window — genuine transient inconsistency,
      // worth a retry next run. Flag it so the caller bumps resolve_attempts
      // (the old code left this path unflagged, which is exactly why ~9,345
      // rows cycled as _stillOpen forever without ever dead-lettering).
      console.warn(`[resolve-outcomes] ${occSymbol} ${day}: daily bar suggested a threshold cross but timesales returned 0 bars (day age ${ageDays}d, still within retention)`)
      sawUnconfirmableRecentCrossing = true
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
        _resolvedDay: day,
      }
    }
    // Daily range suggested a cross but 1-min walk didn't confirm — daily/
    // intraday aggregation mismatch. Continue to next day.
  }

  // No terminal event found in the walked range.
  if (today < expiryDate) {
    if (sawUnconfirmableRecentCrossing) {
      // We DID see a crossing indicated by a daily bar but couldn't confirm
      // it intraday, and the day is still inside the retention window. This
      // is the retryable failure mode — bump the counter so it eventually
      // dead-letters instead of cycling forever (the original bug). The
      // caller treats _retryableGap distinctly from a clean still-open row.
      return { _retryableGap: true }
    }
    // Genuinely still open — no crossing indicated yet, position simply
    // hasn't resolved. NOT an error, do NOT bump the retry counter (bumping
    // here would wrongly dead-letter healthy open LEAPs/swings that just
    // need more time).
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
    _resolvedDay: lastTradingDay,
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

  // Self-terminating guard for the temporary overnight burn-down cron.
  // The 5-min */5 0-9 cron exists ONLY to clear the one-time ~9,200-row
  // backlog created by the earlier silent-stall bug. Once the backlog is
  // gone there's nothing to do, and we do NOT want a 5-min cron pointlessly
  // hammering the shared Tradier token forever (or, worse, someone forgetting
  // to remove it). If there are no unresolved primary rows left, no-op
  // immediately WITHOUT touching Tradier at all — a single cheap count query.
  // This makes removing the cron optional rather than critical.
  //
  // Scoped to burndownMode so the nightly full-run cron (0 23) is unaffected:
  // it should always run its normal course regardless of backlog size.
  const burndownMode = req.query.burndown === '1'
  if (burndownMode) {
    // Count only the timeframes burndown actually processes (Quick+Swing) —
    // "backlog empty" for burndown means those are done, regardless of any
    // remaining long-dated LEAPs (which the nightly cron owns). This count now
    // rides the partial index idx_signal_history_unresolved_primary (~200ms,
    // was ~9.2s full-scan which timed out the client and silently failed the
    // guard open — that's why the guard wasn't working).
    const { count, error: countErr } = await client
      .from('signal_history')
      .select('id', { count: 'exact', head: true })
      .is('outcome', null)
      .eq('is_lifecycle_primary', true)
      .in('timeframe', ['Quick (5–14 DTE)', 'Swing (21–45 DTE)'])
    if (countErr) {
      console.error('[resolve-outcomes] burndown guard count failed:', countErr.message || JSON.stringify(countErr))
      // fall through and run normally rather than block on a transient count error
    } else if ((count || 0) === 0) {
      console.log('[resolve-outcomes] burndown guard: Quick+Swing backlog empty, no-op — safe to remove the */5 burndown cron')
      return res.status(200).json({ burndown: true, backlogEmpty: true, checked: 0, resolved: 0 })
    } else {
      console.log(`[resolve-outcomes] burndown guard: ${count} Quick+Swing unresolved remaining, proceeding`)
    }
  }

  const startedAt = Date.now()
  const MAX_MS = 280_000
  const rateTracker = newRateTracker()

  const BATCH_LIMIT = parseInt(req.query.limit, 10) || 50
  // Per explicit decision (2026-06-29): only walk the PRIMARY row of each
  // signal lifecycle — the same real contract can have 30+ rows from
  // re-qualifying every 15-60 min throughout the day (confirmed live: one
  // contract hit 36x in a single day), and resolving every single one of
  // those would both waste Tradier rate-limit budget on duplicate work AND
  // — more importantly — overweight persistent setups in the win-rate
  // calculation by exactly that multiple. is_lifecycle_primary=true marks
  // the first scan of each real signal, the economically correct entry
  // point. The outcome gets propagated to every row in the lifecycle below
  // (not just the primary), so QA queries against any individual row still
  // see the real, correct final result.
  let query = client
    .from('signal_history')
    .select('*')
    .is('outcome', null)
    .eq('is_lifecycle_primary', true)

  // BURNDOWN MODE targeting: the oldest unresolved rows are LEAP/Deep LEAP
  // with 125-198 day walk spans. Each makes one daily-history Tradier call
  // PER trading day toward a 4-12mo expiry — a single Deep LEAP can burn
  // 100+ calls, and (being long-dated) usually returns _stillOpen anyway,
  // then sits at the front of the ORDER BY scanned_at queue to be re-walked
  // next run. That tarpit is why each burndown run spent ~1,100 calls but
  // resolved only ~10 rows. In burndown mode we therefore process ONLY the
  // short-dated, cheap-to-walk, actually-resolvable timeframes (Quick 5-14
  // DTE, Swing 21-45 DTE — ~7,500 rows, 9-27 day spans). LEAP/Deep LEAP are
  // left to the nightly full-run cron (0 23), which has no such filter. This
  // is a burndown-only optimization; the nightly cron still covers everything.
  if (burndownMode) {
    query = query.in('timeframe', ['Quick (5–14 DTE)', 'Swing (21–45 DTE)'])
  }

  const { data: rows, error: fetchErr } = await query
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

      // _retryableGap and _noUsableData share the same retry-cap machinery:
      // both are "couldn't resolve this run, might later, but must eventually
      // dead-letter rather than cycle forever." _retryableGap is the fix for
      // the original silent-stall bug (crossing indicated, intraday
      // unconfirmable, day still within retention window).
      if (update._retryableGap || update._noUsableData) {
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

      // Terminal resolution. Enrich with the underlying's price on the
      // resolution day before writing (best-effort; NULL if unavailable).
      const underlyingAtResolution = await getUnderlyingCloseOn(row.ticker, update._resolvedDay, rateTracker)
      if (underlyingAtResolution !== null) {
        update.underlying_price_at_resolution = underlyingAtResolution
      }
      delete update._resolvedDay // internal-only, not a real column
      // Propagate to every row sharing this lifecycle, not just the primary
      // row we walked — the duplicate scans of this same real signal
      // (still kept for QA history, see scan.js's lifecycle comment) should
      // show the same real, final outcome if anyone queries them
      // individually, not stay perpetually null just because only the
      // primary row was ever actually resolved.
      const { error } = await client.from('signal_history').update(update).eq('signal_lifecycle_id', row.signal_lifecycle_id)
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
