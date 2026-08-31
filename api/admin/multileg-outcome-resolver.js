const { createClient } = require('@supabase/supabase-js')
const { buildOccSymbol } = require('../_lib/occSymbol')
const { newRateTracker, logRateSummary, getOptionTimesalesDetailed } = require('../_lib/tradierClient')
const { getSessionClose } = require('../_lib/marketCalendar')
const { RESOLUTION_VERSION, resolveCandidateAtExit, selectMarkAtOrBefore, buildResolutionRecord } = require('../_lib/multiLegResolver')

const CRON_SECRET = process.env.CRON_SECRET || ''
let _supabase = null
function sb() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  return _supabase
}

function etParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {})
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

function storedMarketParts(value) {
  const iso = new Date(value).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), compareAt: iso }
}

function determineExitPoint(row) {
  const hitAt = row.hit_target_at || row.hit_stop_at
  if (hitAt) {
    if (String(row.resolution_method || '').startsWith('daily_bar_')) {
      return { ok: false, reason: 'UNDERLYING_EXIT_TIME_NOT_INTRADAY' }
    }
    // Tradier timesales timestamps are exchange-local wall-clock values. The
    // primary resolver historically persisted those values into timestamptz
    // without an offset, so PostgreSQL labelled them UTC. Preserve the stored
    // wall clock here instead of shifting it four/five hours through etParts.
    return { ok: true, ...storedMarketParts(hitAt), source: 'UNDERLYING_THRESHOLD_HIT' }
  }
  if (['expired_partial', 'expired_flat'].includes(row.resolution_method) && row.expiry_raw) {
    const close = getSessionClose(row.expiry_raw) || '16:00'
    return {
      ok: true,
      date: row.expiry_raw,
      time: close,
      compareAt: `${row.expiry_raw}T${close}:00Z`,
      source: 'EXPIRY_SESSION_CLOSE',
    }
  }
  return { ok: false, reason: 'UNDERLYING_EXIT_TIME_UNAVAILABLE' }
}

async function markLeg(row, leg, exit, tracker) {
  const symbol = buildOccSymbol(row.ticker, leg.optionType, leg.strike, row.expiry_raw)
  const response = await getOptionTimesalesDetailed(symbol, `${exit.date} 09:30`, `${exit.date} ${exit.time}`, tracker)
  if (!response.ok) return { ok: false, reason: response.errorType || `HTTP_${response.status}`, retryable: response.retryable }
  const mark = selectMarkAtOrBefore(response.bars, exit.compareAt)
  if (!mark) return { ok: false, reason: 'NO_SYNCHRONIZED_MARK', retryable: false }
  return { ok: true, symbol, close: Number(mark.close), markAt: mark.time || mark.timestamp || mark.date }
}

async function persistRun(run) {
  try {
    const { error } = await sb().from('resolver_runs').insert(run)
    if (error) console.error('[multileg-resolver] resolver_runs insert failed:', error.message)
  } catch (error) {
    console.error('[multileg-resolver] resolver_runs insert threw:', error.message)
  }
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || ''
  const authorized = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
    || (req.query.secret && req.query.secret === CRON_SECRET)
  if (!authorized && process.env.NODE_ENV === 'production') return res.status(401).json({ error: 'Unauthorized' })
  if (req.method && !['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })

  const startedAt = Date.now()
  const tracker = newRateTracker()
  const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 5))
  const { data, error } = await sb().from('signal_history')
    .select('id,ticker,expiry_raw,resolved_at,hit_target_at,hit_stop_at,resolution_method,holding_minutes,shadow_strategy_assignments')
    .eq('is_lifecycle_primary', true)
    .not('resolved_at', 'is', null)
    .not('shadow_strategy_assignments', 'is', null)
    .order('resolved_at', { ascending: false })
    .limit(2000)
  if (error) return res.status(500).json({ error: error.message })

  const rows = (data || []).filter(row => {
    const root = row.shadow_strategy_assignments
    return root?.strategy_candidates?.coverage?.completeComparison === true
      && root?.strategy_candidates?.candidates?.length === 3
      && root?.multileg_resolution?.version !== RESOLUTION_VERSION
  }).slice(0, limit)
  let complete = 0, unavailable = 0, retryable = 0, errors = 0
  let processed = 0
  let circuitBroken = false

  for (const row of rows) {
    if (Date.now() - startedAt > 260_000 || tracker.calls >= 90) { circuitBroken = true; break }
    processed++
    try {
      const root = row.shadow_strategy_assignments
      const candidateResults = []
      const exit = determineExitPoint(row)
      let failure = exit.ok ? null : exit
      if (!failure) {
        for (const candidate of root.strategy_candidates.candidates) {
          const marks = []
          for (const leg of candidate.legs || []) {
            const marked = await markLeg(row, leg, exit, tracker)
            if (!marked.ok) { failure = marked; break }
            marks.push(marked)
          }
          if (failure) break
          const result = resolveCandidateAtExit(candidate, marks.map(mark => mark.close))
          if (!result) { failure = { reason: 'INVALID_CANDIDATE_OR_MARKS', retryable: false }; break }
          candidateResults.push({ ...result, legMarks: marks })
        }
      }
      // Provider/network failures tell us nothing about market data. Do not
      // turn them into terminal unavailable evidence; leave the row eligible
      // for a later resolver pass, matching the main resolver's retry policy.
      if (failure?.retryable) {
        errors++
        retryable++
        const nextJson = {
          ...root,
          multileg_resolution_attempt: {
            version: RESOLUTION_VERSION,
            attemptedAt: new Date().toISOString(),
            exitAt: exit.compareAt || null,
            reason: failure.reason,
            retryable: true,
          },
        }
        const { error: attemptError } = await sb().from('signal_history').update({ shadow_strategy_assignments: nextJson }).eq('id', row.id)
        if (attemptError) console.error(`[multileg-resolver] attempt telemetry id=${row.id}:`, attemptError.message)
        continue
      }
      const dataStatus = !failure && candidateResults.length === 3 ? 'COMPLETE' : 'UNAVAILABLE'
      const nextJson = {
        ...root,
        multileg_resolution: buildResolutionRecord({
          candidateResults: dataStatus === 'COMPLETE' ? candidateResults : [],
          candidateVersion: root.strategy_candidates.version || null,
          exitAt: exit.compareAt || null,
          holdingMinutes: row.holding_minutes,
          dataStatus,
          reason: failure?.reason || null,
        }),
      }
      const { error: updateError } = await sb().from('signal_history').update({ shadow_strategy_assignments: nextJson }).eq('id', row.id)
      if (updateError) errors++
      else if (dataStatus === 'COMPLETE') complete++
      else unavailable++
    } catch (resolverError) {
      console.error(`[multileg-resolver] id=${row.id}:`, resolverError.message)
      errors++
    }
  }
  const durationMs = Date.now() - startedAt
  logRateSummary('multileg-outcome-resolver', tracker, durationMs)
  await persistRun({
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    mode: 'multileg',
    batch_limit: limit,
    rows_fetched: data?.length || 0,
    rows_processed: processed,
    resolved: complete,
    still_open: retryable,
    data_unavailable: unavailable,
    errors,
    circuit_broken: circuitBroken,
    timed_out: Date.now() - startedAt > 260_000,
    tradier_calls: tracker.calls || 0,
    status_counts: tracker.statusCounts || {},
    min_available: tracker.minAvailable,
    skip_reason: rows.length ? null : 'no_complete_comparison_backlog',
    deployment_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
  })
  return res.status(200).json({ checked: rows.length, processed, complete, unavailable, retryable, errors, circuitBroken, durationMs, rateHealth: tracker })
}

module.exports._test = { etParts, storedMarketParts, determineExitPoint }
