// api/cron/credit-shadow-manage.js
//
// swing_credit_spread_managed_v1 — SHADOW ONLY. Once per trading day
// (~15:45 ET) marks every open shadow credit spread at natural prices and
// applies its exit rules (stop, take profit, 21-DTE time exit, expiry
// settlement). Writes only to shadow_credit_positions and resolver_runs.
//
// Known limitation (by design, recorded in the spec): one mark per day, so
// an intraday touch of the stop or target that reverses by 15:45 is missed.

const { createClient } = require('@supabase/supabase-js')
const { newRateTracker, logRateSummary, tFetchPost, getOptionHistory } = require('../_lib/tradierClient')
const { isTradingDay, tzParts } = require('../_lib/marketCalendar')
const { RULES, evaluateExit, computePnl, daysBetween } = require('../_lib/creditSpreadShadow')

const MANAGE_WINDOW = { startMinutes: 15 * 60 + 30, endMinutes: 15 * 60 + 58 } // ET
const DATA_UNAVAILABLE_AFTER_DAYS = 5 // calendar days past expiry with no settlement price
const SESSION_CHECK_SYMBOL = 'SPY'

const asArray = value => !value ? [] : Array.isArray(value) ? value : [value]
const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null }

function etNow(now = new Date()) {
  const p = tzParts(now, 'America/New_York')
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

function quoteTradeDate(quote) {
  const raw = quote?.trade_date ?? quote?.trade_time
  if (raw == null) return null
  const n = Number(raw)
  const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(raw)
  if (!Number.isFinite(d.getTime())) return null
  const p = tzParts(d, 'America/New_York')
  return `${p.year}-${p.month}-${p.day}`
}

function buildMark(position, quotes, today) {
  const s = quotes.get(position.short_symbol)
  const l = quotes.get(position.long_symbol)
  const u = quotes.get(position.ticker)
  return {
    date: today,
    short_bid: num(s?.bid), short_ask: num(s?.ask),
    long_bid: num(l?.bid), long_ask: num(l?.ask),
    underlying: num(u?.last),
  }
}

// Decide the update for one position. Pure apart from the optional
// settlement-price fetch for positions whose expiry already passed.
async function managePosition(position, quotes, today, deps) {
  const expiry = String(position.expiry).slice(0, 10)
  const daysPastExpiry = daysBetween(expiry, today)
  let mark = buildMark(position, quotes, today)

  // Missed the expiry-day run: settle on the expiry-date close, not today's price.
  if (daysPastExpiry > 0) {
    const close = await deps.getCloseOn(position.ticker, expiry)
    if (close == null) {
      if (daysPastExpiry >= DATA_UNAVAILABLE_AFTER_DAYS) {
        return { kind: 'DATA_UNAVAILABLE', update: { status: 'DATA_UNAVAILABLE', updated_at: new Date().toISOString() } }
      }
      return { kind: 'NO_DATA', update: { missing_mark_days: (position.missing_mark_days || 0) + 1, updated_at: new Date().toISOString() } }
    }
    mark = { date: expiry, underlying: close, settlement: 'EXPIRY_CLOSE_HISTORY' }
  }

  const decision = evaluateExit(position, mark, daysPastExpiry > 0 ? expiry : today, RULES)
  const marks = [...asArray(position.daily_marks), mark]
  const base = { daily_marks: marks, last_marked_date: today, updated_at: new Date().toISOString() }

  if (decision.action === 'NO_DATA') {
    return { kind: 'NO_DATA', reason: decision.reason, update: { ...base, missing_mark_days: (position.missing_mark_days || 0) + 1 } }
  }
  if (decision.action === 'HOLD') return { kind: 'HOLD', update: base }

  const pnl = computePnl(position, decision.exitDebit, decision.reason, RULES)
  const entryDate = String(position.entry_at).slice(0, 10)
  return {
    kind: 'CLOSED',
    reason: decision.reason,
    update: {
      ...base,
      status: 'CLOSED',
      exit_at: new Date().toISOString(),
      exit_reason: decision.reason,
      exit_debit_natural: decision.exitDebit,
      days_held: daysBetween(entryDate, daysPastExpiry > 0 ? expiry : today),
      ...pnl,
    },
  }
}

async function runCreditManage({ today, deps }) {
  const positions = await deps.loadOpenPositions()
  const due = positions.filter(p => p.last_marked_date !== today)
  const tally = {}
  const bump = key => { tally[key] = (tally[key] || 0) + 1 }
  let errors = 0
  if (!due.length) return { checked: positions.length, due: 0, tally, errors, sessionConfirmed: null }

  const symbols = new Set([SESSION_CHECK_SYMBOL])
  for (const p of due) { symbols.add(p.short_symbol); symbols.add(p.long_symbol); symbols.add(p.ticker) }
  const quotes = await deps.getQuotes([...symbols])

  // No confirmed session today (holiday, outage, stale feed): mark nothing.
  if (quoteTradeDate(quotes.get(SESSION_CHECK_SYMBOL)) !== today) {
    return { checked: positions.length, due: due.length, tally: { NO_CONFIRMED_SESSION: 1 }, errors, sessionConfirmed: false }
  }

  for (const position of due) {
    try {
      const outcome = await managePosition(position, quotes, today, deps)
      const { error } = await deps.updatePosition(position.id, outcome.update)
      if (error) { errors++; bump('UPDATE_ERROR'); continue }
      bump(outcome.kind === 'CLOSED' ? `CLOSED_${outcome.reason}` : outcome.kind === 'NO_DATA' ? `NO_DATA_${outcome.reason || 'SETTLEMENT'}` : outcome.kind)
    } catch (error) {
      errors++
      bump('EXCEPTION')
      console.error(`[credit-shadow-manage] id=${position.id}:`, error.message)
    }
  }
  return { checked: positions.length, due: due.length, tally, errors, sessionConfirmed: true }
}

function buildLiveDeps(client, tracker) {
  return {
    async loadOpenPositions() {
      const { data, error } = await client.from('shadow_credit_positions')
        .select('*').eq('status', 'OPEN').order('expiry', { ascending: true }).limit(2000)
      if (error) throw new Error(`loadOpenPositions: ${error.message}`)
      return data || []
    },
    async getQuotes(symbols) {
      const map = new Map()
      for (let i = 0; i < symbols.length; i += 100) {
        const chunk = symbols.slice(i, i + 100)
        const d = await tFetchPost('/markets/quotes', `symbols=${encodeURIComponent(chunk.join(','))}&greeks=false`, tracker)
        for (const q of asArray(d?.quotes?.quote)) if (q?.symbol) map.set(q.symbol, q)
      }
      return map
    },
    async getCloseOn(ticker, date) {
      const bars = await getOptionHistory(ticker, date, date, tracker) // generic /markets/history
      const bar = bars.find(b => String(b.date).slice(0, 10) === date)
      return num(bar?.close)
    },
    async updatePosition(id, update) {
      const { error } = await client.from('shadow_credit_positions').update(update).eq('id', id)
      return { error }
    },
  }
}

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || ''
  const allowed = auth === `Bearer ${process.env.CRON_SECRET || '__never__'}`
    || req.headers['x-vercel-cron'] === '1'
    || (req.query.secret && req.query.secret === process.env.CRON_SECRET)
  if (!allowed) return res.status(401).json({ error: 'Unauthorized' })

  const now = new Date()
  const { date: today, minutes } = etNow(now)
  const force = req.query.force === '1'
  if (!isTradingDay(now)) return res.status(200).json({ skipped: true, reason: 'not_a_trading_day' })
  if (!force && (minutes < MANAGE_WINDOW.startMinutes || minutes > MANAGE_WINDOW.endMinutes)) {
    return res.status(200).json({ skipped: true, reason: 'outside_manage_window', etMinutes: minutes })
  }

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const tracker = newRateTracker()
  const startedAt = new Date()
  let result
  try {
    result = await runCreditManage({ today, deps: buildLiveDeps(client, tracker) })
  } catch (error) {
    console.error('[credit-shadow-manage] run failed:', error.message)
    result = { checked: 0, due: 0, tally: { RUN_FAILED: 1 }, errors: 1, failure: error.message }
  }
  logRateSummary('credit-shadow-manage', tracker, Date.now() - startedAt.getTime())

  const closed = Object.entries(result.tally || {}).filter(([k]) => k.startsWith('CLOSED_')).reduce((a, [, v]) => a + v, 0)
  const noData = Object.entries(result.tally || {}).filter(([k]) => k.startsWith('NO_DATA')).reduce((a, [, v]) => a + v, 0)
  const { error: runError } = await client.from('resolver_runs').insert({
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    mode: 'credit_manage',
    batch_limit: Math.max(1, result.due || 1),
    rows_fetched: result.checked || 0,
    rows_processed: result.due || 0,
    resolved: closed,
    still_open: (result.tally?.HOLD || 0),
    data_unavailable: noData + (result.tally?.DATA_UNAVAILABLE || 0),
    errors: result.errors,
    circuit_broken: false,
    timed_out: false,
    tradier_calls: tracker.calls || 0,
    status_counts: tracker.statusCounts || {},
    min_available: tracker.minAvailable,
    skip_reason: result.failure ? `run_failed: ${result.failure}`.slice(0, 500)
      : result.sessionConfirmed === false ? 'no_confirmed_session' : null,
    deployment_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    details: { strategy_version: RULES.strategyVersion, today, tally: result.tally },
  })
  if (runError) console.error('[credit-shadow-manage] resolver_runs insert failed:', runError.message)

  return res.status(result.failure ? 500 : 200).json({ today, ...result })
}

module.exports._test = { runCreditManage, managePosition, buildMark, quoteTradeDate, etNow }
