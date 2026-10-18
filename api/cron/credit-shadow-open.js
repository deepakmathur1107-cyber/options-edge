// api/cron/credit-shadow-open.js
//
// swing_credit_spread_managed_v1 — SHADOW ONLY. Opens paper credit spreads
// once per trading day (~10:30 ET). Writes only to shadow_credit_positions
// and resolver_runs. Never touches live scores, scan_results, or any
// user-facing surface.
//
// Arms (one position per arm/ticker/ISO week, DB-enforced):
//   A_INDEX  SPY, QQQ, IWM, DIA. Bull put above the 200-day SMA, bear call below.
//   B_STOCK  Top liquid names from the latest stock-universe snapshot, split
//            into five fixed weekday buckets so each name is evaluated exactly
//            once per week (no retry-until-it-passes selection bias).
//            Bull put only, and only in a bullish long-term trend.
//   C_SIGNAL Control: today's top Swing signals, direction from the signal,
//            same structure rules as A and B.

const { createClient } = require('@supabase/supabase-js')
const {
  newRateTracker, logRateSummary, tFetch, getExpiries, getChain, getOptionHistory,
} = require('../_lib/tradierClient')
const { getTrendContext } = require('../_lib/trendContext')
const { isTradingDay, tzParts } = require('../_lib/marketCalendar')
const {
  RULES, isoWeekStart, pickExpiry, pickSide, buildCreditSpread, hasEarningsBeforeExpiry,
} = require('../_lib/creditSpreadShadow')

const INDEX_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA']
const B_UNIVERSE_SIZE = 60
const C_DAILY_CAP = 12
const MAX_TRADIER_CALLS = 150
const MIN_RATE_HEADROOM = 20  // stop if Tradier headroom drops this low (token shared with scans)
const MAX_DURATION_MS = 240_000
// ET. Schedules fire at 14:30 and 15:30 UTC; exactly one lands in this
// window in both EDT (14:30 UTC) and EST (15:30 UTC).
const OPEN_WINDOW = { startMinutes: 10 * 60 + 15, endMinutes: 11 * 60 }

const asArray = value => !value ? [] : Array.isArray(value) ? value : [value]

function etNow(now = new Date()) {
  const p = tzParts(now, 'America/New_York')
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

// Fixed weekday bucket (Mon=0..Fri=4) for a ticker.
function weekdayBucket(ticker) {
  let hash = 0
  for (const ch of String(ticker)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % 5
}

function weekdayIndex(dateStr) {
  return (new Date(`${dateStr}T12:00:00Z`).getUTCDay() + 6) % 7
}

async function runCreditOpen({ today, deps, tracker }) {
  const startedAt = Date.now()
  const weekStart = isoWeekStart(today)
  const tally = {}
  const bump = key => { tally[key] = (tally[key] || 0) + 1 }
  const opened = []
  let errors = 0
  let circuitBroken = false

  const existing = await deps.loadWeekKeys(weekStart)
  const dayIndex = weekdayIndex(today)

  const candidates = []
  for (const ticker of INDEX_TICKERS) candidates.push({ arm: 'A_INDEX', ticker })
  const universe = await deps.loadStockUniverse(B_UNIVERSE_SIZE)
  for (const ticker of universe) {
    if (INDEX_TICKERS.includes(ticker)) continue
    if (weekdayBucket(ticker) === dayIndex) candidates.push({ arm: 'B_STOCK', ticker })
  }
  const signals = await deps.loadTodaySwingSignals(today, C_DAILY_CAP)
  for (const signal of signals) {
    candidates.push({ arm: 'C_SIGNAL', ticker: signal.ticker, signal })
  }

  const pending = candidates.filter(c => {
    if (existing.has(`${c.arm}|${c.ticker}`)) { bump('ALREADY_OPEN_THIS_WEEK'); return false }
    return true
  })
  if (!pending.length) return { opened, tally, errors, circuitBroken, candidates: candidates.length, durationMs: Date.now() - startedAt }

  const tickers = [...new Set(pending.map(c => c.ticker))]
  const quotes = await deps.getQuotes(tickers)
  const earnings = await deps.loadEarnings(tickers.filter(t => !INDEX_TICKERS.includes(t)))
  const trendCache = new Map()
  const chainCache = new Map()

  for (const candidate of pending) {
    if (Date.now() - startedAt > MAX_DURATION_MS || tracker.calls >= MAX_TRADIER_CALLS ||
        (tracker.minAvailable != null && tracker.minAvailable <= MIN_RATE_HEADROOM)) {
      circuitBroken = true
      bump('SKIPPED_BUDGET')
      continue
    }
    try {
      const { arm, ticker, signal } = candidate
      const quote = quotes.get(ticker)
      const price = Number(quote?.last)
      if (!(price > 0)) { bump('NO_QUOTE'); continue }

      let trend = null
      if (arm !== 'C_SIGNAL') {
        if (!trendCache.has(ticker)) trendCache.set(ticker, await deps.getTrend(ticker))
        trend = trendCache.get(ticker)
      }
      const side = pickSide({
        arm, price, sma200: trend?.sma200, trend: trend?.direction, signalOptionType: signal?.option_type,
      })
      if (!side) { bump(`NO_SIDE_${arm}`); continue }

      const expiry = pickExpiry(await deps.getExpiries(ticker), today)
      if (!expiry) { bump('NO_EXPIRY_IN_WINDOW'); continue }
      if (arm !== 'A_INDEX' && hasEarningsBeforeExpiry(earnings.get(ticker), today, expiry.expiry)) {
        bump('EARNINGS_BEFORE_EXPIRY'); continue
      }

      const chainKey = `${ticker}|${expiry.expiry}`
      if (!chainCache.has(chainKey)) chainCache.set(chainKey, await deps.getChain(ticker, expiry.expiry))
      const built = buildCreditSpread({ chain: chainCache.get(chainKey), price, side, arm })
      if (!built.ok) { bump(built.reason); continue }

      const row = {
        strategy_version: RULES.strategyVersion,
        measurement_version: RULES.measurementVersion,
        arm,
        ticker,
        expiry: expiry.expiry,
        dte_at_entry: expiry.dte,
        entry_week: weekStart,
        trend_at_entry: arm === 'A_INDEX'
          ? (price > Number(trend?.sma200) ? 'above_sma200' : 'below_sma200')
          : (trend?.direction || null),
        source_signal_id: signal?.id ?? null,
        ...built.spread,
      }
      const result = await deps.insertPosition(row)
      if (result.error) { errors++; bump('INSERT_ERROR'); continue }
      if (!result.inserted) { bump('ALREADY_OPEN_THIS_WEEK'); continue }
      opened.push({ arm, ticker, side, expiry: expiry.expiry, credit: built.spread.entry_credit_natural, width: built.spread.width })
      bump('OPENED')
    } catch (error) {
      errors++
      bump('EXCEPTION')
      console.error(`[credit-shadow-open] ${candidate.arm} ${candidate.ticker}:`, error.message)
    }
  }
  return { opened, tally, errors, circuitBroken, candidates: candidates.length, durationMs: Date.now() - startedAt }
}

function buildLiveDeps(client, tracker) {
  return {
    async loadWeekKeys(weekStart) {
      const { data, error } = await client.from('shadow_credit_positions')
        .select('arm,ticker').eq('entry_week', weekStart)
      if (error) throw new Error(`loadWeekKeys: ${error.message}`)
      return new Set((data || []).map(r => `${r.arm}|${r.ticker}`))
    },
    async loadStockUniverse(limit) {
      const { data: latest, error: latestError } = await client.from('stock_universe_snapshots')
        .select('snapshot_date').eq('eligible', true)
        .order('snapshot_date', { ascending: false }).limit(1).maybeSingle()
      if (latestError) throw new Error(`loadStockUniverse: ${latestError.message}`)
      if (!latest) return []
      const { data, error } = await client.from('stock_universe_snapshots')
        .select('ticker,average_volume').eq('snapshot_date', latest.snapshot_date).eq('eligible', true)
        .not('average_volume', 'is', null)
        .order('average_volume', { ascending: false }).limit(limit)
      if (error) throw new Error(`loadStockUniverse: ${error.message}`)
      return (data || []).map(r => r.ticker)
    },
    async loadTodaySwingSignals(today, cap) {
      const { data, error } = await client.from('signal_history')
        .select('id,ticker,option_type,score,scanned_at')
        .eq('is_lifecycle_primary', true)
        .eq('qualification_source', 'LIVE_AT_SIGNAL')
        .eq('market_session_status', 'LIVE_REGULAR_SESSION')
        .like('timeframe', 'Swing%')
        .gte('scanned_at', `${today}T00:00:00-05:00`)
        .order('score', { ascending: false })
        .limit(200)
      if (error) throw new Error(`loadTodaySwingSignals: ${error.message}`)
      const best = new Map()
      for (const row of data || []) if (!best.has(row.ticker)) best.set(row.ticker, row)
      return [...best.values()].slice(0, cap)
    },
    async loadEarnings(tickers) {
      if (!tickers.length) return new Map()
      const { data, error } = await client.from('ticker_fundamentals')
        .select('ticker,earnings_date').in('ticker', tickers)
      if (error) throw new Error(`loadEarnings: ${error.message}`)
      return new Map((data || []).map(r => [r.ticker, r.earnings_date]))
    },
    async getQuotes(symbols) {
      const map = new Map()
      for (let i = 0; i < symbols.length; i += 50) {
        const chunk = symbols.slice(i, i + 50)
        const d = await tFetch(`/markets/quotes?symbols=${encodeURIComponent(chunk.join(','))}&greeks=false`, tracker)
        for (const q of asArray(d?.quotes?.quote)) if (q?.symbol) map.set(q.symbol, q)
      }
      return map
    },
    getTrend: ticker => getTrendContext(ticker, null, getOptionHistory, tracker),
    getExpiries: ticker => getExpiries(ticker, tracker),
    getChain: (ticker, expiry) => getChain(ticker, expiry, tracker),
    async insertPosition(row) {
      const { data, error } = await client.from('shadow_credit_positions')
        .upsert(row, { onConflict: 'arm,ticker,entry_week', ignoreDuplicates: true })
        .select('id')
      if (error) return { inserted: false, error }
      return { inserted: (data || []).length > 0, error: null }
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
  // Two UTC schedules cover EDT and EST; only the one inside the ET window acts.
  if (!force && (minutes < OPEN_WINDOW.startMinutes || minutes > OPEN_WINDOW.endMinutes)) {
    return res.status(200).json({ skipped: true, reason: 'outside_open_window', etMinutes: minutes })
  }

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  // One evaluation per trading day. Re-running would retry tickers that were
  // rejected this morning, which biases the sample toward whatever happens
  // to pass later in the day. force=1 is for manual recovery only.
  if (!force) {
    const { data: priorRuns, error: priorError } = await client.from('resolver_runs')
      .select('id,skip_reason').eq('mode', 'credit_open')
      .gte('started_at', new Date(Date.now() - 12 * 3600_000).toISOString())
    if (priorError) return res.status(503).json({ error: 'resolver_runs unavailable', detail: priorError.message })
    if ((priorRuns || []).some(r => !String(r.skip_reason || '').startsWith('run_failed'))) {
      return res.status(200).json({ skipped: true, reason: 'already_ran_today' })
    }
  }

  const tracker = newRateTracker()
  const startedAt = new Date()
  let result
  try {
    result = await runCreditOpen({ today, deps: buildLiveDeps(client, tracker), tracker })
  } catch (error) {
    console.error('[credit-shadow-open] run failed:', error.message)
    result = { opened: [], tally: { RUN_FAILED: 1 }, errors: 1, circuitBroken: false, candidates: 0, failure: error.message }
  }
  logRateSummary('credit-shadow-open', tracker, Date.now() - startedAt.getTime())

  const { error: runError } = await client.from('resolver_runs').insert({
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    mode: 'credit_open',
    batch_limit: Math.max(1, result.candidates || 1),
    rows_fetched: result.candidates || 0,
    rows_processed: Object.values(result.tally || {}).reduce((a, b) => a + b, 0),
    resolved: result.opened.length,
    still_open: 0,
    data_unavailable: 0,
    errors: result.errors,
    circuit_broken: result.circuitBroken,
    timed_out: false,
    tradier_calls: tracker.calls || 0,
    status_counts: tracker.statusCounts || {},
    min_available: tracker.minAvailable,
    skip_reason: result.failure ? `run_failed: ${result.failure}`.slice(0, 500) : null,
    deployment_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    details: { strategy_version: RULES.strategyVersion, today, tally: result.tally, opened: result.opened },
  })
  if (runError) console.error('[credit-shadow-open] resolver_runs insert failed:', runError.message)

  return res.status(result.failure ? 500 : 200).json({ today, ...result })
}

module.exports._test = { runCreditOpen, weekdayBucket, weekdayIndex, etNow, INDEX_TICKERS }
