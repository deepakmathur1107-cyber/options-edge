const RESOLUTION_VERSION = 'synchronized_multileg_v1'
const DEFAULT_COSTS = Object.freeze({ slippageBpsPerLegSide: 25, feePerContractSide: 0.65 })

function finite(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveCandidateAtExit(candidate, legMarks, costs = DEFAULT_COSTS) {
  const legs = candidate?.legs || []
  if (!legs.length || legs.length !== legMarks.length) return null
  const normalizedMarks = legMarks.map(finite)
  if (normalizedMarks.some(mark => mark == null || mark < 0)) return null
  const exitValue = legs.reduce((sum, leg, index) => sum + Number(leg.quantity) * normalizedMarks[index], 0)
  const entryDebit = finite(candidate.entryDebit)
  const entryCredit = finite(candidate.entryCredit)
  const entryCashflow = entryDebit != null ? -entryDebit : entryCredit
  const maxRisk = finite(candidate.maxLoss)
  if (entryCashflow == null || !(maxRisk > 0)) return null
  const legCount = legs.reduce((sum, leg) => sum + Math.abs(Number(leg.quantity) || 0), 0)
  const entryBasis = Math.abs(entryDebit ?? entryCredit)
  const exitBasis = normalizedMarks.reduce((sum, mark) => sum + Math.abs(mark), 0)
  const slippage = (entryBasis + exitBasis) * costs.slippageBpsPerLegSide / 10_000 * legCount
  const feesPerShare = legCount * costs.feePerContractSide * 2 / 100
  const grossPnl = entryCashflow + exitValue
  const netPnl = grossPnl - slippage - feesPerShare
  return {
    strategyId: candidate.id,
    family: candidate.family,
    grossPnlPerShare: grossPnl,
    netPnlPerShare: netPnl,
    returnOnRisk: netPnl / maxRisk,
    maxRiskPerShare: maxRisk,
    exitValuePerShare: exitValue,
    estimatedSlippagePerShare: slippage,
    estimatedFeesPerShare: feesPerShare,
    outcome: netPnl > 0 ? 'WIN' : netPnl < 0 ? 'LOSS' : 'FLAT',
  }
}

function selectMarkAtOrBefore(bars, exitAt) {
  const target = new Date(exitAt).getTime()
  if (!Number.isFinite(target)) return null
  return (bars || []).map(bar => ({
    bar,
    time: new Date(bar.time || bar.timestamp || bar.date).getTime(),
  })).filter(item => Number.isFinite(item.time) && item.time <= target && finite(item.bar.close) != null)
    .sort((a, b) => b.time - a.time)[0]?.bar || null
}

function buildResolutionRecord({ candidateResults, candidateVersion = null, exitAt, holdingMinutes, dataStatus, reason = null, resolvedAt = new Date().toISOString() }) {
  return {
    version: RESOLUTION_VERSION,
    candidateVersion,
    evidenceType: 'ACTUAL_SYNCHRONIZED_LEG_MARKS',
    sameSignalTiming: true,
    costModelApplied: true,
    exitAt,
    holdingMinutes: finite(holdingMinutes),
    dataStatus,
    unavailableReason: reason,
    candidates: candidateResults || [],
    resolvedAt,
    publishEligibleEvidence: dataStatus === 'COMPLETE' && (candidateResults || []).length === 3,
  }
}

module.exports = { RESOLUTION_VERSION, DEFAULT_COSTS, resolveCandidateAtExit, selectMarkAtOrBefore, buildResolutionRecord }
