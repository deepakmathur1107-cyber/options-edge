const { createClient } = require('@supabase/supabase-js')
const { buildOccSymbol } = require('../_lib/occSymbol')
const { newRateTracker, logRateSummary, getOptionTimesalesDetailed } = require('../_lib/tradierClient')
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

async function markLeg(row, leg, tracker) {
  const exit = etParts(row.resolved_at)
  const symbol = buildOccSymbol(row.ticker, leg.optionType, leg.strike, row.expiry_raw)
  const response = await getOptionTimesalesDetailed(symbol, `${exit.date} 09:30`, `${exit.date} ${exit.time}`, tracker)
  if (!response.ok) return { ok: false, reason: response.errorType || `HTTP_${response.status}`, retryable: response.retryable }
  const mark = selectMarkAtOrBefore(response.bars, row.resolved_at)
  if (!mark) return { ok: false, reason: 'NO_SYNCHRONIZED_MARK', retryable: false }
  return { ok: true, symbol, close: Number(mark.close), markAt: mark.time || mark.timestamp || mark.date }
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || ''
  const authorized = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}` || (req.query.secret && req.query.secret === CRON_SECRET)
  if (!authorized && process.env.NODE_ENV === 'production') return res.status(401).json({ error: 'Unauthorized' })
  if (req.method && !['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })

  const startedAt = Date.now()
  const tracker = newRateTracker()
  const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 5))
  const { data, error } = await sb().from('signal_history')
    .select('id,ticker,expiry_raw,resolved_at,holding_minutes,shadow_strategy_assignments')
    .eq('is_lifecycle_primary', true)
    .not('resolved_at', 'is', null)
    .not('shadow_strategy_assignments', 'is', null)
    .order('resolved_at', { ascending: false })
    .limit(500)
  if (error) return res.status(500).json({ error: error.message })

  const rows = (data || []).filter(row => {
    const root = row.shadow_strategy_assignments
    return root?.strategy_candidates?.candidates?.length && root?.multileg_resolution?.version !== RESOLUTION_VERSION
  }).slice(0, limit)
  let complete = 0, unavailable = 0, errors = 0

  for (const row of rows) {
    if (Date.now() - startedAt > 260_000 || tracker.calls >= 90) break
    try {
      const root = row.shadow_strategy_assignments
      const candidateResults = []
      let failure = null
      for (const candidate of root.strategy_candidates.candidates) {
        const marks = []
        for (const leg of candidate.legs || []) {
          const marked = await markLeg(row, leg, tracker)
          if (!marked.ok) { failure = marked; break }
          marks.push(marked)
        }
        if (failure) break
        const result = resolveCandidateAtExit(candidate, marks.map(mark => mark.close))
        if (!result) { failure = { reason: 'INVALID_CANDIDATE_OR_MARKS', retryable: false }; break }
        candidateResults.push({ ...result, legMarks: marks })
      }
      // Provider/network failures tell us nothing about market data. Do not
      // turn them into terminal unavailable evidence; leave the row eligible
      // for a later resolver pass, matching the main resolver's retry policy.
      if (failure?.retryable) { errors++; continue }
      const dataStatus = !failure && candidateResults.length === 3 ? 'COMPLETE' : 'UNAVAILABLE'
      const nextJson = {
        ...root,
        multileg_resolution: buildResolutionRecord({
          candidateResults: dataStatus === 'COMPLETE' ? candidateResults : [],
          exitAt: row.resolved_at,
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
  return res.status(200).json({ checked: rows.length, complete, unavailable, errors, durationMs, rateHealth: tracker })
}

module.exports._test = { etParts }
