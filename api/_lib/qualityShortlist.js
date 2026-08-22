const QUALITY_SHORTLIST_VERSION = 'quality_shortlist_v1'
const { evaluateProfitabilityGate } = require('./oeProfitability')

const DEFAULT_RULES = Object.freeze({
  minimumScore: 80,
  maximumSpreadPct: 8,
  minimumVolume: 100,
  minimumOpenInterest: 500,
})

const WARNING_RULES = Object.freeze([
  ['OPENING_WINDOW', /market open|first 30 min/i],
  ['EARNINGS_RISK', /earnings/i],
  ['RESISTANCE_RISK', /resistance/i],
  ['COUNTER_TREND', /counter-trend/i],
  ['THESIS_NOT_CONFIRMED', /against this (call|put)|doesn.t support the thesis/i],
  ['LOW_PROBABILITY_MOVE', /low probability/i],
  ['CATALYST_MISSING', /no identifiable catalyst|needs catalyst/i],
  ['RELATIVE_VOLUME_WEAK', /low volume|weak conviction/i],
  ['GAP_PREMIUM_EXPANDED', /gap play|premium is expanded/i],
  ['DIRECTION_CONCENTRATED', /correlated market-wide bet|signals are calls|signals are puts/i],
])

function parseDisplayNumber(value) {
  if (value == null || value === '') return null
  const number = Number(String(value).replace(/[$,%\s,]/g, ''))
  return Number.isFinite(number) ? number : null
}

function buildQualityShortlistDecision(row = {}, rules = DEFAULT_RULES) {
  const exclusions = []
  const score = Number(row.score)
  const bid = parseDisplayNumber(row.bid)
  const ask = parseDisplayNumber(row.ask)
  const mid = parseDisplayNumber(row.mid ?? row.entry_mid)
  const volume = Number(row.volume || 0)
  const openInterest = Number(row.oi ?? row.open_interest ?? 0)
  const optionType = String(row.option_type || row.trade_type || '').toLowerCase()
  const hardBlocks = Array.isArray(row.hard_blocks) ? row.hard_blocks : []
  const warnings = Array.isArray(row.warnings) ? row.warnings.map(String) : []
  const spreadPct = mid > 0 && bid != null && ask != null
    ? ((ask - bid) / mid) * 100
    : null
  const profitabilityGate = evaluateProfitabilityGate(row.profitability_validation)

  // A setup may remain visible for research, but it is never publishable as
  // a recommendation without positive out-of-sample expectancy after costs.
  if (!profitabilityGate.publish) exclusions.push('PROFITABILITY_NOT_VALIDATED')

  if (!Number.isFinite(score) || score < rules.minimumScore) exclusions.push('SCORE_BELOW_80')
  // Forward evidence through 2026-08-13 keeps puts research-only. Continue
  // measuring them, but do not label them TAKE until a separately validated
  // put strategy clears the documented promotion gates.
  if (optionType === 'put') exclusions.push('PUT_STRATEGY_RESEARCH_ONLY')
  if (hardBlocks.length) exclusions.push('HARD_BLOCK')
  if (spreadPct == null) exclusions.push('SPREAD_UNAVAILABLE')
  else if (spreadPct > rules.maximumSpreadPct) exclusions.push('SPREAD_ABOVE_8_PCT')
  if (volume < rules.minimumVolume) exclusions.push('VOLUME_BELOW_100')
  if (openInterest < rules.minimumOpenInterest) exclusions.push('OPEN_INTEREST_BELOW_500')
  const warningText = warnings.join(' | ')
  for (const [reason, pattern] of WARNING_RULES) {
    if (pattern.test(warningText)) exclusions.push(reason)
  }

  return {
    version: QUALITY_SHORTLIST_VERSION,
    eligible: exclusions.length === 0,
    publish_decision: profitabilityGate.decision,
    profitability_gate: profitabilityGate,
    exclusions: [...new Set(exclusions)],
    metrics: {
      score: Number.isFinite(score) ? score : null,
      spreadPct: spreadPct == null ? null : Math.round(spreadPct * 100) / 100,
      volume,
      openInterest,
    },
    disclaimer: 'Educational shortlist only; verify the live quote, thesis, and personal risk before acting.',
  }
}

function attachQualityShortlist(rows) {
  for (const row of rows || []) row.quality_shortlist = buildQualityShortlistDecision(row)
  return rows
}

module.exports = {
  QUALITY_SHORTLIST_VERSION,
  DEFAULT_RULES,
  buildQualityShortlistDecision,
  attachQualityShortlist,
}
