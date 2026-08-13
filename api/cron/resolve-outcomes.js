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

const { newRateTracker, logRateSummary, getOptionHistory, getOptionTimesales, getOptionTimesalesDetailed, getOptionHistoryDetailed } = require('../_lib/tradierClient')
const { buildOccSymbol } = require('../_lib/occSymbol')
const { tradingDaysBetween, getSessionClose, timeToMinutes, isTradingDay } = require('../_lib/marketCalendar')
const { buildProfitabilityMetrics } = require('../_lib/profitabilityMetrics')

const CRON_SECRET = process.env.CRON_SECRET || ''
const MAX_RETRIES = 5   // cap on resolution attempts before dead-lettering a row (spec §5)
const MIN_TRADIER_HEADROOM = 75
const QUALIFIED_BATCH_LIMIT = 25
const QUALIFIED_MAX_CALLS = 100
const BURNDOWN_MAX_CALLS = 300

// Tradier's /markets/timesales retains 1-min bars for only ~10 calendar days
// (confirmed against Tradier docs, 2026-07). Any crossing day older than this
// can NEVER be confirmed at 1-min resolution again — the data is gone. The
// original resolver assumed timesales was durably available whenever we got
// around to it; it isn't. We use a conservative 9-day cutoff (one day of
// safety margin under the documented 10) to decide when to stop attempting
// intraday confirmation and fall back to daily-bar-only resolution.
const TIMESALES_RETENTION_DAYS = 9

function daysAgo(dateStr, now = new Date()) {
  const d = new Date(dateStr + 'T12:00:00')
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
}

function scanTimeInNewYork(scannedAt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(scannedAt))
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const hour = p.hour === '24' ? '00' : p.hour
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}:${p.second}`,
  }
}

function barIsOnOrAfterSignal(barTime, scanMarketTime) {
  if (!barTime) return true
  const raw = String(barTime)
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  if (hasExplicitOffset) {
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) return true
    const barMarketTime = scanTimeInNewYork(parsed)
    return `${barMarketTime.date}T${barMarketTime.time}` >=
      `${scanMarketTime.date}T${scanMarketTime.time}`
  }
  const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/)
  if (!localMatch) return true
  const localTime = localMatch[2].length === 5 ? `${localMatch[2]}:00` : localMatch[2]
  return `${localMatch[1]}T${localTime}` >=
    `${scanMarketTime.date}T${scanMarketTime.time}`
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

function addPendingResolutionFilters(query) {
  return query.is('outcome', null).is('resolved_at', null)
}

function resolverModeConfig(query = {}) {
  const qualifiedMode = query.qualified === '1'
  const burndownMode = query.burndown === '1'
  const requestedLimit = parseInt(query.limit, 10)
  return {
    qualifiedMode,
    burndownMode,
    batchLimit: requestedLimit || (qualifiedMode ? QUALIFIED_BATCH_LIMIT : 50),
    maxTradierCalls: qualifiedMode ? QUALIFIED_MAX_CALLS : BURNDOWN_MAX_CALLS,
  }
}

function rateBudgetReached(rateTracker, maxTradierCalls) {
  if ((rateTracker.calls || 0) >= maxTradierCalls) return true
  return rateTracker.minAvailable != null &&
    Number.isFinite(Number(rateTracker.minAvailable)) &&
    Number(rateTracker.minAvailable) <= MIN_TRADIER_HEADROOM
}

async function persistResolverRun(client, run) {
  try {
    const { error } = await client.from('resolver_runs').insert(run)
    if (error) console.error('[resolve-outcomes] resolver_runs insert failed:', error.message)
  } catch (e) {
    console.error('[resolve-outcomes] resolver_runs insert threw:', e.message)
  }
}

function buildDeadLetterQuery(client, row, attempts, resolvedAt) {
  const query = client.from('signal_history').update({
    resolve_attempts: attempts,
    resolution_method: 'data_unavailable',
    resolved_at: resolvedAt,
  })
  return row.signal_lifecycle_id
    ? query.eq('signal_lifecycle_id', row.signal_lifecycle_id)
    : query.eq('id', row.id)
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

function shouldRunBurndownNow(now = new Date()) {
  if (!isTradingDay(now)) return false
  const marketTime = scanTimeInNewYork(now)
  const close = getSessionClose(marketTime.date)
  const minutes = timeToMinutes(marketTime.time)
  const closeMinutes = timeToMinutes(close)
  return minutes != null && closeMinutes != null && minutes >= closeMinutes + 15
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
async function resolveOne(row, rateTracker, dependencies = {}) {
  const getHistory = dependencies.getOptionHistory || getOptionHistory
  const getTimesales = dependencies.getOptionTimesales || getOptionTimesales
  const getTimesalesDetailed = dependencies.getOptionTimesalesDetailed || getOptionTimesalesDetailed
  const getHistoryDetailed = dependencies.getOptionHistoryDetailed || getOptionHistoryDetailed
  const now = dependencies.now ? new Date(dependencies.now) : new Date()
  const occSymbol = buildOccSymbol(row.ticker, row.option_type, row.primary_strike, row.expiry_raw)
  const entryMid    = parseFloat(row.entry_mid)
  const targetPrice = entryMid * (1 + parseFloat(row.profit_target_pct))
  const stopPrice   = entryMid * (1 - parseFloat(row.stop_loss_pct))

  const expiryDate  = new Date(row.expiry_raw + 'T12:00:00')
  const today       = now
  const scanMarketTime = scanTimeInNewYork(row.scanned_at)
  const scanClose = getSessionClose(scanMarketTime.date)
  const scanMinutes = timeToMinutes(scanMarketTime.time)
  const closeMinutes = timeToMinutes(scanClose)

  // Walk forward from either the day after the last CONFIRMED-clean day
  // (if we've checked this row before) or scanned_at's market day (first
  // check), through either today or expiry, whichever is earlier.
  //
  // ROOT CAUSE FIX (2026-07-25): before this, startDay was ALWAYS
  // scannedDate+1, regardless of how many times this row had already been
  // checked — every still-open row re-walked its ENTIRE history from
  // scratch on every single run, forever, since _stillOpen correctly never
  // bumps resolve_attempts (that's for genuine failures, not healthy open
  // positions) and so never got deprioritized by the query's ORDER BY
  // either. Confirmed live: burndown mode was burning ~1,456 Tradier
  // calls/run while the unresolved count sat static at 6,649 across 20+
  // consecutive runs — re-confirming the same already-clean days over and
  // over, not making progress. last_walked_through persists how far the
  // walk got last time (see the _stillOpen return + caller below), so a
  // row checked yesterday now only re-walks the 1-2 NEW trading days since
  // then instead of the full history back to entry.
  const walkEnd = today < expiryDate ? today : expiryDate
  let startDay = row.last_walked_through
    ? (() => { const d = new Date(row.last_walked_through + 'T12:00:00'); d.setDate(d.getDate() + 1); return d })()
    : new Date(scanMarketTime.date + 'T12:00:00')
  if (!row.last_walked_through && scanMinutes != null && closeMinutes != null && scanMinutes >= closeMinutes) {
    startDay.setDate(startDay.getDate() + 1)
  }
  const days = tradingDaysBetween(startDay, walkEnd)

  // Tracks whether the walk hit a crossing day that we COULD have confirmed
  // at 1-min but timesales came back empty (real inconsistency, worth
  // retrying) vs. a crossing day already past the retention window (never
  // retryable — must go to daily-bar fallback). These drive different caller
  // behavior: the former bumps the retry counter, the latter goes straight
  // to fallback resolution rather than pretending a future retry might help.
  let sawUnconfirmableRecentCrossing = false

  // AUDIT FIX (2026-07-25, Finding 4 continued): tracks the day BEFORE a
  // real API failure, so the walk cursor never silently advances past a
  // day that was never actually checked. Without this, a `continue` on
  // failure still let the cursor jump to walkEnd once the loop finished,
  // permanently losing that day's real price action — a transient outage
  // partway through a walk could cause a real crossing to be silently
  // missed forever, not just delayed. null means "no real failure hit
  // yet" (walk can advance the cursor all the way to walkEnd as before);
  // once set, it caps how far the cursor is allowed to advance THIS RUN.
  let stoppedEarlyAt = null
  let walkFailed = false
  let maxOptionHigh = row.walk_max_option_high != null &&
    Number.isFinite(Number(row.walk_max_option_high))
    ? Number(row.walk_max_option_high)
    : null
  let minOptionLow = row.walk_min_option_low != null &&
    Number.isFinite(Number(row.walk_min_option_low))
    ? Number(row.walk_min_option_low)
    : null
  const recordBars = bars => {
    for (const bar of bars || []) {
      const high = Number(bar.high)
      const low = Number(bar.low)
      if (Number.isFinite(high)) maxOptionHigh = maxOptionHigh == null ? high : Math.max(maxOptionHigh, high)
      if (Number.isFinite(low)) minOptionLow = minOptionLow == null ? low : Math.min(minOptionLow, low)
    }
  }
  const terminal = update => ({
    ...update,
    _maxOptionHigh: maxOptionHigh,
    _minOptionLow: minOptionLow,
  })
  const recordThroughHit = (bars, hit) => {
    if (!hit?.at) return recordBars(bars)
    const hitIndex = bars.findIndex(bar => bar.time === hit.at)
    recordBars(hitIndex >= 0 ? bars.slice(0, hitIndex + 1) : bars)
  }

  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    const day = days[dayIndex]
    const isEntryDay = !row.last_walked_through && day === scanMarketTime.date

    // The daily bar contains price action before the signal. For entry day,
    // inspect only one-minute bars at or after scanned_at.
    if (isEntryDay && daysAgo(day, now) <= TIMESALES_RETENTION_DAYS) {
      // AUDIT FIX (2026-07-25, Finding 4): was getTimesales (bare array),
      // which returns [] both when Tradier genuinely has no trades yet AND
      // when the request itself failed (429/5xx/network error/auth) —
      // completely indistinguishable. bars.length===0 then set
      // sawUnconfirmableRecentCrossing=true, which DOES increment
      // resolve_attempts toward dead-lettering (see _retryableGap below) —
      // meaning a transient Tradier hiccup could push a signal toward being
      // wrongly marked data_unavailable. getTimesalesDetailed distinguishes
      // the two: a genuine empty response keeps the existing retryable
      // behavior; a real failure just skips this day with NO penalty this
      // run (the row is untouched, picked up fresh next run for free — the
      // existing batch-level circuit breaker still catches a sustained
      // outage across the run, so this isn't the only safety net).
      // AUDIT FIX (2026-07-25, Finding 5): was hardcoded '16:00' — wrong on
      // early-close days (day after Thanksgiving, Christmas Eve, July 3rd
      // when applicable), where the real session close is 13:00 ET. A
      // signal generated after 13:00 on an early-close day would have
      // requested a window (e.g. 14:00-16:00) that never had any real
      // trading in it, indistinguishable from "genuinely no post-signal
      // trades" — getSessionClose returns the correct close for the date;
      // day is always a real trading day here (from tradingDaysBetween),
      // so the '16:00' fallback is defensive, not expected to fire.
      const entryStartMinutes = Math.max(scanMinutes ?? 9 * 60 + 30, 9 * 60 + 30)
      if (closeMinutes == null || entryStartMinutes >= closeMinutes) continue
      const entryStart = `${String(Math.floor(entryStartMinutes / 60)).padStart(2, '0')}:${String(entryStartMinutes % 60).padStart(2, '0')}`
      const result = await getTimesalesDetailed(
        occSymbol,
        `${day} ${entryStart}`,
        `${day} ${scanClose}`,
        rateTracker,
      )
      if (!result.ok) {
        // Real API failure, not genuine emptiness. Stop the walk here
        // (not just skip this day) — see stoppedEarlyAt comment above.
        stoppedEarlyAt = dayIndex > 0 ? days[dayIndex - 1] : null
        walkFailed = true
        break
      }
      const bars = result.bars
      if (bars.length === 0) {
        sawUnconfirmableRecentCrossing = true
        continue
      }
      const postSignalBars = bars.filter(bar => barIsOnOrAfterSignal(bar.time, scanMarketTime))
      const hit = findFirstThresholdHit(postSignalBars, targetPrice, stopPrice)
      recordThroughHit(postSignalBars, hit)
      if (hit) {
        return terminal({
          outcome: hit.outcome,
          hit_target_at: hit.outcome === 'WIN' ? hit.at : null,
          hit_stop_at: hit.outcome === 'LOSS' ? hit.at : null,
          resolved_at: now.toISOString(),
          resolution_method: hit.type,
          _resolvedDay: day,
        })
      }
      continue
    }

    // Step 1 — cheap pre-check via daily history. Skip the 1-min pull
    // entirely if neither threshold could possibly have been crossed that
    // day (spec §4 step 1).
    //
    // AUDIT FIX (2026-07-25, Finding 4 continued): was getHistory (bare
    // array) — [] meant either "no daily bar this day" (rare, e.g. a real
    // data gap) or "the request failed" (429/5xx/network), and both fell
    // through to `continue`, silently letting the walk move past this day.
    // Once the loop finished, the cursor advanced to walkEnd regardless —
    // meaning a transient failure on ANY day in the middle of a walk could
    // cause that day's real price action to be permanently skipped and
    // never re-examined. Now: a real failure BREAKS the walk (stoppedEarlyAt
    // caps the cursor at the day before), so the failed day gets retried
    // next run. A genuine missing daily bar (request succeeded, Tradier
    // just has no bar for this day) keeps the original behavior — skip and
    // continue, since that's a real, if rare, data characteristic, not a
    // request failure.
    const historyResult = await getHistoryDetailed(occSymbol, day, day, rateTracker)
    if (!historyResult.ok) {
      if (historyResult.status === 400) return { _noUsableData: true, _badRequest: true }
      stoppedEarlyAt = dayIndex > 0 ? days[dayIndex - 1] : null
      walkFailed = true
      break
    }
    const dailyBars = historyResult.days
    const dailyBar = dailyBars[0]
    if (!dailyBar) {
      // No data this specific day — see note below; single missing day is
      // skipped, walk continues.
      continue
    }
    recordBars([dailyBar])
    const couldHaveCrossed = dailyBar.high >= targetPrice || dailyBar.low <= stopPrice
    if (!couldHaveCrossed) continue

    // A crossing is indicated. Decide HOW to confirm based on the day's age.
    const ageDays = daysAgo(day, now)

    if (isEntryDay) {
      return terminal({
        outcome: 'AMBIGUOUS',
        resolved_at: now.toISOString(),
        resolution_method: 'entry_day_daily_crossing_unverifiable',
        _resolvedDay: day,
      })
    }

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
        return terminal({
          outcome: 'AMBIGUOUS',
          resolved_at: now.toISOString(),
          resolution_method: 'daily_bar_both_crossed_ambiguous',
          _resolvedDay: day,
        })
      }
      if (dHitTarget) {
        return terminal({
          outcome: 'WIN',
          hit_target_at: `${day}T00:00:00Z`, // day-level only; no intraday timestamp available
          resolved_at: now.toISOString(),
          resolution_method: 'daily_bar_fallback_target',
          _resolvedDay: day,
        })
      }
      // dHitStop
      return terminal({
        outcome: 'LOSS',
        hit_stop_at: `${day}T00:00:00Z`,
        resolved_at: now.toISOString(),
        resolution_method: 'daily_bar_fallback_stop',
        _resolvedDay: day,
      })
    }

    // Recent enough — intraday confirmation is still possible. Step 2: real
    // 1-min bars for this specific day only.
    //
    // AUDIT FIX (2026-07-25, Finding 4 continued): was getTimesales (bare
    // array) — same conflation as the other two call sites. Real failure
    // now breaks the walk (cursor capped at the day before, retried next
    // run) instead of being treated as the genuine-empty retryable-gap case
    // below, which specifically bumps resolve_attempts toward eventual
    // dead-lettering — that bump should only happen for a REAL data
    // inconsistency (daily bar says crossed, timesales genuinely has
    // nothing), not an unrelated API hiccup.
    // AUDIT FIX (2026-07-25, Finding 5): same session-close fix as the
    // entry-day request above — was hardcoded '16:00'.
    const timesalesResult = await getTimesalesDetailed(occSymbol, `${day} 09:30`, `${day} ${getSessionClose(day) || '16:00'}`, rateTracker)
    if (!timesalesResult.ok) {
      stoppedEarlyAt = dayIndex > 0 ? days[dayIndex - 1] : null
        walkFailed = true
      break
    }
    const bars = timesalesResult.bars
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
    recordThroughHit(bars, hit)
    if (hit) {
      return terminal({
        outcome: hit.outcome,
        hit_target_at: hit.outcome === 'WIN' ? hit.at : null,
        hit_stop_at:   hit.outcome === 'LOSS' ? hit.at : null,
        resolved_at: now.toISOString(),
        resolution_method: hit.type,
        _resolvedDay: day,
      })
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
    // need more time). DO persist how far the walk got as the new resume
    // cursor — see startDay comment above — so the NEXT check only walks
    // forward from here instead of re-walking the whole history.
    //
    // AUDIT FIX (2026-07-25, Finding 4 continued): was unconditionally
    // walkEnd, even if a real API failure had stopped the walk partway
    // through — silently advancing the cursor PAST an unchecked day,
    // losing it forever. Three distinct cases now: (1) no failure this
    // run — safe to advance cursor all the way to walkEnd, as before;
    // (2) failure after at least one successful day — cursor advances up
    // to (not including) the failed day; (3) failure on the very FIRST day
    // checked this run — no safe progress to record at all, so
    // _lastWalkedThrough is omitted entirely (undefined), and the caller's
    // `if (update._lastWalkedThrough)` guard correctly skips the DB write,
    // leaving the existing cursor untouched for a clean retry next run.
    const cursorDate = !walkFailed
      ? walkEnd.toISOString().slice(0, 10)
      : stoppedEarlyAt // already a 'YYYY-MM-DD' string or null
    return {
      _stillOpen: true,
      _lastWalkedThrough: cursorDate,
      _maxOptionHigh: maxOptionHigh,
      _minOptionLow: minOptionLow,
    }
  }

  // Past expiry with no threshold ever crossed → terminal expired state
  // (spec §4 step 5). Use the last available daily close as exit price.
  // NOTE: if `days` is empty here (only possible if scanned_at and expiry_raw
  // are the same trading day, or expiry has already passed before the walk
  // ever ran), there's no day to pull a close from — that's the
  // data_unavailable path below, not a bug to paper over with a recomputed
  // range that would also come back empty for the same reason.
  // `days` is only the INCREMENTAL walk since last_walked_through. Once a
  // row has already been walked through expiry that range is intentionally
  // empty, but we still need the expiry-session close to settle it. Derive
  // settlement independently from the cursor so a caught-up expired row
  // does not loop through _noUsableData forever without making an API call.
  const settlementLookback = new Date(expiryDate)
  settlementLookback.setDate(settlementLookback.getDate() - 7)
  const settlementDays = tradingDaysBetween(settlementLookback, expiryDate)
  const lastTradingDay = settlementDays[settlementDays.length - 1] || null
  const closeBars = lastTradingDay ? await getHistory(occSymbol, lastTradingDay, lastTradingDay, rateTracker) : []
  const exitMid = closeBars[0]?.close ?? null
  recordBars(closeBars)

  if (exitMid === null) {
    // Expired and we never got a single usable price print for it. Don't
    // dead-letter on the first occurrence — pass the gap up to the caller,
    // which increments resolve_attempts and only marks data_unavailable
    // once MAX_RETRIES is exceeded (spec §5: "cap retries, then dead-letter").
    return { _noUsableData: true }
  }

  const pnlPct = (exitMid - entryMid) / entryMid
  return terminal({
    outcome: pnlPct > 0 ? 'EXPIRED_PARTIAL' : 'EXPIRED_FLAT',
    exit_mid_at_expiry: exitMid,
    pnl_pct_at_expiry: pnlPct,
    resolved_at: now.toISOString(),
    resolution_method: pnlPct > 0 ? 'expired_partial' : 'expired_flat',
    _resolvedDay: lastTradingDay,
  })
}

module.exports = async function handler(req, res) {
  const runStartedAt = new Date()
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
  const {
    qualifiedMode,
    burndownMode,
    batchLimit: BATCH_LIMIT,
    maxTradierCalls,
  } = resolverModeConfig(req.query)
  const priorityMode = qualifiedMode || burndownMode
  if (priorityMode && !isManualTrigger && !shouldRunBurndownNow(runStartedAt)) {
    await persistResolverRun(client, {
      started_at: runStartedAt.toISOString(),
      finished_at: new Date().toISOString(),
      mode: qualifiedMode ? 'qualified' : 'burndown',
      batch_limit: BATCH_LIMIT,
      rows_fetched: 0,
      rows_processed: 0,
      resolved: 0,
      still_open: 0,
      data_unavailable: 0,
      errors: 0,
      circuit_broken: false,
      timed_out: false,
      tradier_calls: 0,
      status_counts: {},
      skip_reason: 'market_closed_no_new_outcome_data',
      deployment_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    })
    return res.status(200).json({
      burndown: burndownMode,
      qualified: qualifiedMode,
      skipped: true,
      reason: 'market_closed_no_new_outcome_data',
      checked: 0,
      resolved: 0,
    })
  }
  if (burndownMode) {
    // Count only the timeframes burndown actually processes (Quick+Swing) —
    // "backlog empty" for burndown means those are done, regardless of any
    // remaining long-dated LEAPs (which the nightly cron owns). This count now
    // rides the partial index idx_signal_history_unresolved_primary (~200ms,
    // was ~9.2s full-scan which timed out the client and silently failed the
    // guard open — that's why the guard wasn't working).
    const countQuery = client
      .from('signal_history')
      .select('id', { count: 'exact', head: true })
    const { count, error: countErr } = await addPendingResolutionFilters(countQuery)
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

  const startedAt = runStartedAt.getTime()
  const MAX_MS = 280_000
  const rateTracker = newRateTracker()

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
  let query = addPendingResolutionFilters(client
    .from('signal_history')
    .select('*'))
    .eq('is_lifecycle_primary', true)

  // THIRD TARPIT FIX (2026-07-25, found investigating a live "calls=0 every
  // run" report): rows whose last_walked_through is ALREADY today cannot
  // make any progress this run — tradingDaysBetween(startDay, walkEnd)
  // comes back empty, resolveOne does zero work and returns immediately.
  // These rows still have resolve_attempts=0 (a clean walk was never a
  // "failure"), so they TIE with genuinely-never-touched rows on the
  // primary sort key — and WIN the scanned_at-ascending tiebreak whenever
  // they happen to be chronologically older signals, since ordering
  // doesn't know "already fully caught up" should be deprioritized.
  // Confirmed live: exactly 100 rows (== BATCH_LIMIT) were stuck in this
  // state, permanently occupying every single batch slot while 6,530
  // genuinely-untouched rows never got a turn — 6+ consecutive runs, 30+
  // minutes, zero net progress despite a real backlog sitting right there.
  // Excluding already-caught-up rows here is strictly correct, not just a
  // workaround: there is nothing this run COULD do for them regardless of
  // ordering, so removing them from contention is the actual fix, not a
  // band-aid on the sort order.
  query = query.or(`last_walked_through.is.null,last_walked_through.lt.${new Date().toISOString().slice(0, 10)}`)

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
    query = query
      .in('timeframe', ['Quick (5–14 DTE)', 'Swing (21–45 DTE)'])
      .or('qualification_source.neq.LIVE_AT_SIGNAL,qualification_source.is.null,strategy_qualified.neq.true,strategy_qualified.is.null')
  } else if (qualifiedMode) {
    query = query
      .eq('qualification_source', 'LIVE_AT_SIGNAL')
      .eq('strategy_qualified', true)
      .eq('market_session_status', 'LIVE_REGULAR_SESSION')
  }

  const { data: rows, error: fetchErr } = await query
    // Second tarpit fix: order untried rows (resolve_attempts null/0) BEFORE
    // already-retried ones. Without this, a row stuck on its 4th failed
    // attempt (unconfirmable-but-in-retention-window) sits in the exact same
    // scanned_at position every run and keeps re-consuming a batch slot
    // alongside rows that have never been looked at yet — confirmed live:
    // TMO260710P00500000 appeared in 6+ consecutive burndown runs without
    // resolving, at ~950 Tradier calls/run for ~3 net resolutions/run.
    // resolve_attempts is NULL for never-attempted rows, which Postgres sorts
    // first under NULLS FIRST (the default for ascending) — exactly the
    // order we want, no coalesce needed. Already-struggling rows still get a
    // turn (they're just deprioritized, not excluded) and still dead-letter
    // normally via MAX_RETRIES once they do come up.
    .order('resolve_attempts', { ascending: true, nullsFirst: true })
    .order('scanned_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) {
    console.error('[resolve-outcomes] fetch failed:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }

  let resolved = 0, stillOpen = 0, dataUnavailable = 0, errors = 0, rowsProcessed = 0
  const results = []
  let circuitBroken = false
  let timedOut = false
  let rateBudgetHit = false

  for (const row of rows) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[resolve-outcomes] time budget reached, stopping early this run')
      timedOut = true
      break
    }
    if (rateBudgetReached(rateTracker, maxTradierCalls)) {
      console.warn(`[resolve-outcomes] API budget reached: calls=${rateTracker.calls}, ` +
        `remaining=${rateTracker.minAvailable}, reserve=${MIN_TRADIER_HEADROOM}`)
      rateBudgetHit = true
      break
    }
    rowsProcessed++

    // Circuit breaker (added 2026-07-17): confirmed live overnight that
    // sustained Tradier 400s get silently absorbed by tFetch (returns null on
    // any !r.ok, indistinguishable from a real "no data" day — see
    // getOptionHistory/getOptionTimesales in tradierClient.js). That let a
    // degraded API masquerade as a healthy resolver making no progress: 4
    // consecutive runs burned ~1,250 calls each with statusCounts climbing to
    // 66 x 400, while resolved stayed flat at 0. Rather than change tFetch's
    // return contract (used by scan.js and others — too broad a change to
    // make safely tonight), detect the degradation from tracker.statusCounts,
    // which already exists, and stop early rather than burn the rest of the
    // batch's Tradier budget for zero benefit. Rows not yet reached this run
    // are simply left untouched (same as the existing time-budget-exceeded
    // path) — no resolve_attempts penalty, they're picked up fresh next run
    // once the API (hopefully) recovers.
    // Thresholds: only evaluate once tracker.calls >= 50 (avoid tripping on
    // early-run noise), then trip only on retryable upstream failures.
    // Deterministic 400s are row-level data problems and must not make the
    // entire resolver pretend Tradier is unavailable.
    if (rateTracker.calls >= 50) {
      const retryableFailures = (rateTracker.statusCounts[429] || 0) +
        Object.entries(rateTracker.statusCounts).reduce((sum, [status, count]) =>
          Number(status) >= 500 ? sum + Number(count) : sum, 0)
      const failureRate = retryableFailures / rateTracker.calls
      if (failureRate > 0.25) {
        console.warn(`[resolve-outcomes] ⚠️ CIRCUIT BREAKER — stopping early: ` +
          `${rateTracker.calls} calls, ${Math.round(failureRate * 100)}% retryable failures ` +
          `(statusCounts=${JSON.stringify(rateTracker.statusCounts)}). ` +
          `Tradier appears degraded — not burning the rest of this batch's budget for no progress.`)
        circuitBroken = true
        break
      }
    }

    try {
      const update = await resolveOne(row, rateTracker)
      if (update._stillOpen) {
        stillOpen++
        // Persist the resume cursor (see resolveOne's startDay comment) so
        // the NEXT check doesn't re-walk this row's entire history again.
        // Best-effort: a failed write here just means the next run re-walks
        // from scratch again (the OLD behavior) rather than anything
        // incorrect — never worth failing the whole batch over.
        if (update._lastWalkedThrough) {
          const cursorUpdate = { last_walked_through: update._lastWalkedThrough }
          if (update._maxOptionHigh != null) cursorUpdate.walk_max_option_high = update._maxOptionHigh
          if (update._minOptionLow != null) cursorUpdate.walk_min_option_low = update._minOptionLow
          const { error: cursorErr } = await client.from('signal_history')
            .update(cursorUpdate)
            .eq('id', row.id)
          if (cursorErr) console.error(`[resolve-outcomes] cursor persist failed id=${row.id}:`, cursorErr.message)
        }
        continue
      }

      // _retryableGap and _noUsableData share the same retry-cap machinery:
      // both are "couldn't resolve this run, might later, but must eventually
      // dead-letter rather than cycle forever." _retryableGap is the fix for
      // the original silent-stall bug (crossing indicated, intraday
      // unconfirmable, day still within retention window).
      if (update._retryableGap || update._noUsableData) {
        const attempts = (row.resolve_attempts || 0) + 1
        if (attempts >= MAX_RETRIES) {
          dataUnavailable++
          const { error } = await buildDeadLetterQuery(
            client,
            row,
            attempts,
            new Date().toISOString(),
          )
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
        // direction_correct (added 2026-07-21, per outside review
        // recommendation for an "underlying-first outcome engine" — was the
        // STOCK direction correct, independent of whether the option itself
        // hit target/stop. Same logic already used ad-hoc all week (the
        // ~90%-wrong-direction finding) now computed automatically for every
        // future resolution instead of requiring a manual analysis query.
        if (row.underlying_price != null) {
          update.direction_correct = row.option_type === 'call'
            ? underlyingAtResolution > row.underlying_price
            : underlyingAtResolution < row.underlying_price
        }
      }
      Object.assign(update, buildProfitabilityMetrics(row, update))
      delete update._maxOptionHigh
      delete update._minOptionLow
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

  await persistResolverRun(client, {
    started_at: runStartedAt.toISOString(),
    finished_at: new Date().toISOString(),
    mode: qualifiedMode ? 'qualified' : (burndownMode ? 'burndown' : (isManualTrigger ? 'manual' : 'nightly')),
    batch_limit: BATCH_LIMIT,
    rows_fetched: rows.length,
    rows_processed: rowsProcessed,
    resolved,
    still_open: stillOpen,
    data_unavailable: dataUnavailable,
    errors,
    circuit_broken: circuitBroken,
    timed_out: timedOut,
    tradier_calls: rateTracker.calls,
    status_counts: rateTracker.statusCounts,
    min_available: rateTracker.minAvailable,
    deployment_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
  })

  return res.status(200).json({
    checked: rowsProcessed,
    resolved, stillOpen, dataUnavailable, errors,
    circuitBroken, // true if this run stopped early due to a Tradier failure-rate spike, not the normal batch/time limits
    rateBudgetHit,
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

module.exports._test = {
  addPendingResolutionFilters,
  barIsOnOrAfterSignal,
  buildDeadLetterQuery,
  daysAgo,
  findFirstThresholdHit,
  resolveOne,
  scanTimeInNewYork,
  shouldRunBurndownNow,
  persistResolverRun,
  rateBudgetReached,
  resolverModeConfig,
}
