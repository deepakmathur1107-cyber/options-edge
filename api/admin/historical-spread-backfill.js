// api/admin/historical-spread-backfill.js
// Added 2026-07-21. Expedites Phase 1's validation timeline: rather than
// wait weeks for NEW shadow spreads to reach expiry, retroactively compute
// what a spread would have looked like on the ~1,600 already-resolved
// Swing/LEAP/Deep LEAP signals from two weeks ago — those are already fully
// aged past their own expiry, so there's zero waiting involved.
//
// HONEST LIMITATION, stated plainly: Tradier has no historical options-chain
// snapshot endpoint — chains are live-only. The live shadow builder
// (verticalSpread.js) picks a short leg by scanning a REAL chain for a
// liquid (bid>0), correctly-sided strike. This backfill can't do that for a
// past date. Instead it COMPUTES a theoretical short strike using the same
// width formula, then fetches THAT SPECIFIC CONTRACT's historical daily
// price directly. If Tradier has no data for it, that's the honest signal
// it wasn't a real/liquid strike that day — marked 'unknown', not
// fabricated. Entry price uses the daily CLOSE as a proxy for mid (no
// historical bid/ask exists) — coarser than the live builder's real
// bid/ask, which is exactly why this writes to separate
// historical_shadow_spread_* columns rather than the live-forward ones.
// Settlement math reuses the EXACT logic already traced and verified in
// shadow-spread-resolver.js yesterday — not reinvented here.

const { newRateTracker, logRateSummary, getOptionHistory } = require('../_lib/tradierClient')
const { buildOccSymbol } = require('../_lib/occSymbol')
const { autoStep } = require('../_lib/scanLogic')
const { spreadWidthSteps } = require('../_lib/verticalSpread')

const CRON_SECRET = process.env.CRON_SECRET || ''

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[historical-spread-backfill] supabase init failed:', e.message) }
  }
  return _sb
}

// closestBar: shared helper, same pattern used in shortened-hold-backtest.js
// and shadow-spread-resolver.js.
function closestBar(bars, targetDate) {
  if (!bars.length) return null
  const target = targetDate.getTime()
  return bars.reduce((best, b) => {
    const bt = new Date(b.date || targetDate).getTime()
    const bestT = new Date(best.date || targetDate).getTime()
    return Math.abs(bt - target) < Math.abs(bestT - target) ? b : best
  }, bars[0])
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
  const BATCH_LIMIT = parseInt(req.query.limit, 10) || 50 // lower default than other backtests — 2 Tradier calls/row, want headroom
  const rateTracker = newRateTracker()
  let circuitBroken = false

  const { data: rows, error: fetchErr } = await client
    .from('signal_history')
    .select('id, ticker, timeframe, option_type, primary_strike, expiry_raw, entry_mid, underlying_price, scanned_at')
    .eq('is_lifecycle_primary', true)
    .not('outcome', 'is', null)
    .neq('outcome', 'AMBIGUOUS')
    // BUG FIX (2026-07-21): was gated on historical_shadow_spread_pnl_pct
    // IS NULL — but pnl_pct only gets SET on a successful computation; the
    // 'unknown' path (no historical data, non-positive debit, degenerate
    // width) sets historical_shadow_spread_outcome but leaves pnl_pct null
    // forever. Confirmed live: 10 runs only advanced 85 new rows (135 total,
    // 50 stuck as 'unknown') because the same oldest 50 unknown rows kept
    // re-matching this filter and eating most of every batch — same tarpit
    // class as the resolver's original silent-stall bug. Gating on
    // historical_shadow_spread_outcome IS NULL instead is correct because
    // outcome is set on EVERY path (success or unknown), so a truly-
    // processed row (of either kind) is excluded from now on.
    .is('historical_shadow_spread_outcome', null)
    .in('timeframe', ['Swing (21–45 DTE)', 'LEAP (90–180 DTE)', 'Deep LEAP (180–365 DTE)'])
    .order('scanned_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!rows || !rows.length) {
    return res.status(200).json({ checked: 0, backfilled: 0, message: 'Nothing left to backfill.' })
  }

  let backfilled = 0, errors = 0

  for (const row of rows) {
    if (Date.now() - startedAt > MAX_MS) { console.warn('[historical-spread-backfill] time budget reached'); break }
    if (rateTracker.calls >= 50) {
      const okCount = rateTracker.statusCounts[200] || 0
      if (1 - (okCount / rateTracker.calls) > 0.25) {
        console.warn('[historical-spread-backfill] ⚠️ CIRCUIT BREAKER — stopping early')
        circuitBroken = true
        break
      }
    }

    try {
      const widthSteps = spreadWidthSteps[row.timeframe]
      const price = row.underlying_price
      const longStrike = row.primary_strike
      if (!widthSteps || !price || !longStrike) { errors++; continue }

      const step = autoStep(price)
      const width = widthSteps * step
      const rawTarget = row.option_type === 'call' ? longStrike + width : longStrike - width
      const shortStrike = Math.round(rawTarget / step) * step // rounded to a plausible real strike increment — best-effort, not chain-verified

      const scannedAt = new Date(row.scanned_at)
      const entryRangeStart = new Date(scannedAt); entryRangeStart.setDate(entryRangeStart.getDate() - 1)
      const entryRangeEnd   = new Date(scannedAt); entryRangeEnd.setDate(entryRangeEnd.getDate() + 2)
      const shortOcc = buildOccSymbol(row.ticker, row.option_type, shortStrike, row.expiry_raw)
      const entryBars = await getOptionHistory(shortOcc, entryRangeStart.toISOString().slice(0,10), entryRangeEnd.toISOString().slice(0,10), rateTracker)
      const entryBar = closestBar(entryBars, scannedAt)

      if (!entryBar || typeof entryBar.close !== 'number') {
        // No real historical data for the computed strike — honest unknown,
        // not a fabricated spread. This is the expected outcome for a
        // meaningful fraction of rows given no chain-verification is
        // possible; see file header.
        await client.from('signal_history').update({ historical_shadow_spread_outcome: 'unknown' }).eq('id', row.id)
        backfilled++
        continue
      }

      const shortEntryProxy = entryBar.close // daily close as a mid proxy — no historical bid/ask exists
      const netDebit = Math.round((row.entry_mid - shortEntryProxy) * 100) / 100
      if (netDebit <= 0) {
        await client.from('signal_history').update({ historical_shadow_spread_outcome: 'unknown' }).eq('id', row.id)
        backfilled++
        continue
      }
      const actualWidth = Math.abs(shortStrike - longStrike)
      const maxProfit = Math.round((actualWidth - netDebit) * 100) / 100
      if (maxProfit <= 0) {
        await client.from('signal_history').update({ historical_shadow_spread_outcome: 'unknown' }).eq('id', row.id)
        backfilled++
        continue
      }

      // Settlement — EXACT same math as shadow-spread-resolver.js (traced
      // and verified 2026-07-20), just fetching the underlying stock's
      // price here instead of assuming it's precomputed.
      const expiry = new Date(row.expiry_raw + 'T12:00:00')
      const settleStart = new Date(expiry); settleStart.setDate(settleStart.getDate() - 3)
      const settleEnd   = new Date(expiry); settleEnd.setDate(settleEnd.getDate() + 1)
      const settleBars = await getOptionHistory(row.ticker, settleStart.toISOString().slice(0,10), settleEnd.toISOString().slice(0,10), rateTracker)
      const settleBar = closestBar(settleBars, expiry)

      let outcome, pnlPct, historicalSpread
      if (!settleBar || typeof settleBar.close !== 'number') {
        outcome = 'unknown'
        pnlPct = null
        historicalSpread = null
      } else {
        const settlementPrice = settleBar.close
        const rawIntrinsic = row.option_type === 'call' ? settlementPrice - longStrike : longStrike - settlementPrice
        const intrinsicValue = Math.max(0, Math.min(actualWidth, rawIntrinsic))
        pnlPct = Math.round(((intrinsicValue - netDebit) / netDebit) * 10000) / 100
        outcome = intrinsicValue >= actualWidth ? 'FULL_WIN' : intrinsicValue <= 0 ? 'TOTAL_LOSS' : 'PARTIAL'
        historicalSpread = {
          long_strike: longStrike, short_strike: shortStrike, spread_width: actualWidth,
          net_debit: netDebit, max_profit: maxProfit, max_loss: netDebit,
        }
      }

      const { error: updateErr } = await client
        .from('signal_history')
        .update({
          historical_shadow_spread: historicalSpread,
          historical_shadow_spread_pnl_pct: pnlPct,
          historical_shadow_spread_outcome: outcome,
        })
        .eq('id', row.id)
      if (updateErr) { console.error(`[historical-spread-backfill] update failed id=${row.id}:`, updateErr.message); errors++ }
      else backfilled++
    } catch (e) {
      console.error(`[historical-spread-backfill] ${row.ticker} failed:`, e.message)
      errors++
    }
  }

  const durationMs = Date.now() - startedAt
  logRateSummary('historical-spread-backfill', rateTracker, durationMs)

  return res.status(200).json({
    checked: rows.length, backfilled, errors, circuitBroken, durationMs,
    rateHealth: { tradierCalls: rateTracker.calls, statusCounts: rateTracker.statusCounts, minAvailable: rateTracker.minAvailable },
  })
}
