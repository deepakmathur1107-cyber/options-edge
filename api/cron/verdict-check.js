// api/cron/verdict-check.js
//
// Item 5 — hold/close verdict engine. NOT YET added to vercel.json's crons
// array on purpose (explicit instruction, June 26 2026 session: build
// complete, deploy to test stream, do NOT wire into the live production
// schedule yet). Callable manually via ?secret= for testing, same pattern
// as every other cron in this codebase (scan.js, resolve-outcomes.js).
//
// DRY_RUN MODE: defaults to dryRun=true unless explicitly overridden via
// ?dryRun=false in the query string. In dry-run, every trade is checked and
// logged to the response + console, but NO row is written to
// verdict_checks and NO trades row is touched. This exists specifically so
// the first real-world runs can be reviewed (via Vercel function logs or
// the JSON response) before any write path is trusted unattended over a
// weekend — see session decision.
//
// Loops trades WHERE status = 'Open', calls checkVerdict (api/_lib/
// verdictCheck.js) for each, and writes a verdict_checks row ONLY when the
// flagged state actually changes from what was last recorded for that
// trade — never on every check, per the earlier session decision (same
// reasoning as signal_history's volume: log transitions, not every poll).

const { checkVerdict } = require('../_lib/verdictCheck')

const CRON_SECRET = process.env.CRON_SECRET || ''

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[cron/verdict-check] supabase init failed:', e.message) }
  }
  return _sb
}

// getLastFlaggedState: the most recent verdict_checks row for this trade
// tells us what state we're transitioning FROM. No row yet = treat as
// "clear" (a freshly-logged trade with no history is assumed not-flagged
// until proven otherwise — matches the natural default, and avoids writing
// a spurious "first ever check" row for the common case of a trade that's
// simply fine from the start).
async function getLastFlaggedState(client, tradeId) {
  const { data, error } = await client
    .from('verdict_checks')
    .select('flagged')
    .eq('trade_id', tradeId)
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error(`[cron/verdict-check] failed to read last state for trade ${tradeId}:`, error.message)
    return null   // treat as unknown -- caller decides how to handle
  }
  return data ? data.flagged : false
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
                     || req.headers['x-vercel-cron'] === '1'
  const isManualTrigger = req.query.secret && req.query.secret === CRON_SECRET
  if (!isVercelCron && !isManualTrigger && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized — cron secret missing/invalid' })
  }

  // DRY RUN is the default. Must be EXPLICITLY set to 'false' to write —
  // any other value (missing, 'true', typo) stays safe and dry.
  const dryRun = req.query.dryRun !== 'false'

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  const startedAt = Date.now()
  const MAX_MS = 280_000

  const { data: openTrades, error: fetchErr } = await client
    .from('trades')
    .select('id, ticker, option_type, strike, expiration, entry_price, target_price, stop_price, conviction, timeframe')
    .eq('status', 'Open')

  if (fetchErr) {
    console.error('[cron/verdict-check] failed to fetch open trades:', fetchErr.message)
    return res.status(500).json({ error: fetchErr.message })
  }

  const tracker = { calls: 0, statusCounts: {} }
  let checked = 0, skipped = 0, flaggedNow = 0, transitions = 0, errors = 0
  const results = []

  for (const trade of (openTrades || [])) {
    if (Date.now() - startedAt > MAX_MS) {
      console.warn('[cron/verdict-check] time budget reached, stopping early this run')
      break
    }
    try {
      const verdict = await checkVerdict(trade, tracker)
      checked++

      if (verdict.skipped) {
        skipped++
        results.push({ tradeId: trade.id, ticker: trade.ticker, skipped: true, reason: verdict.reason })
        continue
      }

      if (verdict.flagged) flaggedNow++

      // last_verdict_check_at / current_score / flagged — all updated on
      // EVERY successful check, in ONE write, not just on transitions.
      // last_verdict_check_at distinguishes "checked and currently fine"
      // from "never checked" (found during live testing — a healthy,
      // never-flagged trade wrote zero verdict_checks rows ever, by that
      // table's correct transition-only design, but that made it
      // indistinguishable from never-checked). current_score/flagged let
      // the Trades tab UI show current state WITHOUT a live recheck on
      // every page view — a deliberate choice to avoid an uncapped,
      // per-view Tradier call stacking on the cron's own scheduled usage
      // (already seen tonight getting close to the 120/min wall on a real
      // scan run). Respects dryRun same as the verdict_checks write below.
      if (!dryRun) {
        const { error: touchErr } = await client
          .from('trades')
          .update({
            last_verdict_check_at: verdict.checkedAt,
            current_score: verdict.currentScore,
            flagged: verdict.flagged,
          })
          .eq('id', trade.id)
        if (touchErr) {
          console.error(`[cron/verdict-check] failed to update current state for trade ${trade.id}:`, touchErr.message)
        }
      }

      const lastState = await getLastFlaggedState(client, trade.id)
      const isTransition = lastState === null ? true : (lastState !== verdict.flagged)
      // lastState === null means the read itself failed (not "no history") —
      // treat as a transition so it gets logged rather than silently
      // skipped, erring toward over-logging on a read error rather than
      // potentially missing a real flag because Supabase hiccuped.

      results.push({
        tradeId: trade.id, ticker: trade.ticker,
        currentScore: verdict.currentScore, entryScore: verdict.entryScore,
        scoreDelta: verdict.scoreDelta, flagged: verdict.flagged,
        flagReasons: verdict.flagReasons, isTransition,
      })

      if (isTransition) {
        transitions++
        if (!dryRun) {
          const { error: writeErr } = await client.from('verdict_checks').insert({
            trade_id: trade.id,
            checked_at: verdict.checkedAt,
            current_score: verdict.currentScore,
            entry_score: verdict.entryScore,
            score_delta: verdict.scoreDelta,
            current_mid: verdict.currentMid,
            flagged: verdict.flagged,
            flag_reasons: verdict.flagReasons,
            occ_symbol: verdict.occSymbol,
          })
          if (writeErr) {
            errors++
            console.error(`[cron/verdict-check] write failed for trade ${trade.id} (${trade.ticker}):`, writeErr.message)
          }
        }
      }

      // Suggest-only close prompts. Fires on hit_target/hit_stop
      // REGARDLESS of isTransition above — a trade can stay flagged across
      // many consecutive checks while still having no UNRESOLVED
      // suggestion, if the user already confirmed/dismissed an earlier
      // one. Reuses verdict.currentMid/target_price/stop_price already
      // fetched by checkVerdict above for the flagging decision — NOT a
      // second resolver hitting Tradier independently.
      //
      // REBUILT (Sat morning) after discovering an earlier, debugged
      // version of this never actually shipped — it existed in-sandbox but
      // wasn't carried into the deploy round that followed. This version
      // uses explicit check-then-insert (NOT upsert+onConflict), per two
      // real bugs found and fixed while originally drafting this: (1)
      // onConflict/ignoreDuplicates are .upsert() options, not .insert()
      // options; (2) PostgREST's onConflict cannot target a partial
      // (WHERE-qualified) unique index at all -- confirmed against
      // PostgREST's own open feature-request issue for this. The migration
      // for this table has NO partial unique index this time; dedup is
      // purely this check-then-insert, application-level.
      const hitTargetOrStop = (verdict.flagReasons || []).some(r => r === 'hit_target' || r === 'hit_stop')
      if (hitTargetOrStop && !dryRun) {
        const reason = verdict.flagReasons.includes('hit_target') ? 'hit_target' : 'hit_stop'
        const { data: existingPending } = await client
          .from('trade_close_suggestions')
          .select('id')
          .eq('trade_id', trade.id)
          .eq('status', 'pending')
          .maybeSingle()

        if (!existingPending) {
          const { error: suggestErr } = await client
            .from('trade_close_suggestions')
            .insert({
              trade_id: trade.id,
              reason,
              trigger_mid: verdict.currentMid,
              target_price: trade.target_price,
              stop_price: trade.stop_price,
            })
          if (suggestErr) {
            console.warn(`[cron/verdict-check] suggestion insert failed for trade ${trade.id} (${trade.ticker}):`, suggestErr.message)
          }
        }
      }
    } catch (e) {
      errors++
      console.error(`[cron/verdict-check] unhandled error for trade ${trade.id} (${trade.ticker}):`, e.message)
      results.push({ tradeId: trade.id, ticker: trade.ticker, error: e.message })
    }
  }

  const durationMs = Date.now() - startedAt
  console.log(`[cron/verdict-check] dryRun=${dryRun} checked=${checked} skipped=${skipped} ` +
    `flaggedNow=${flaggedNow} transitions=${transitions} errors=${errors} ` +
    `tradierCalls=${tracker.calls} duration=${durationMs}ms`)

  return res.status(200).json({
    dryRun, checked, skipped, flaggedNow, transitions, errors, durationMs,
    tradierCalls: tracker.calls, statusCounts: tracker.statusCounts,
    results,
  })
}
