const DEFAULT_ENTRY_SLIPPAGE_BPS = 25
const DEFAULT_EXIT_SLIPPAGE_BPS = 25
const DEFAULT_FEE_PER_CONTRACT_SIDE = 0.65

function finiteNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function buildProfitabilityMetrics(row, resolution, options = {}) {
  const entryMid = finiteNumber(row.entry_mid)
  const ask = finiteNumber(row.ask)
  const targetPct = finiteNumber(row.profit_target_pct)
  const stopPct = finiteNumber(row.stop_loss_pct)
  if (!(entryMid > 0) || !(targetPct > 0) || !(stopPct > 0)) return {}

  const entrySlippageBps = finiteNumber(options.entrySlippageBps) ?? DEFAULT_ENTRY_SLIPPAGE_BPS
  const exitSlippageBps = finiteNumber(options.exitSlippageBps) ?? DEFAULT_EXIT_SLIPPAGE_BPS
  const feePerSide = finiteNumber(options.feePerContractSide) ?? DEFAULT_FEE_PER_CONTRACT_SIDE
  const entryReference = ask > 0 ? ask : entryMid
  const estimatedEntry = entryReference * (1 + entrySlippageBps / 10_000)

  let exitReference = null
  if (resolution.outcome === 'WIN') exitReference = entryMid * (1 + targetPct)
  else if (resolution.outcome === 'LOSS') exitReference = entryMid * (1 - stopPct)
  else exitReference = finiteNumber(resolution.exit_mid_at_expiry)
  if (!(exitReference >= 0)) return { estimated_entry_price: round(estimatedEntry) }

  const estimatedExit = Math.max(0, exitReference * (1 - exitSlippageBps / 10_000))
  const grossPnlDollars = (exitReference - estimatedEntry) * 100
  const netPnlDollars = (estimatedExit - estimatedEntry) * 100 - feePerSide * 2
  const plannedRiskDollars = Math.max(
    0.01,
    (estimatedEntry - Math.max(0, entryMid * (1 - stopPct) * (1 - exitSlippageBps / 10_000))) * 100 +
      feePerSide * 2,
  )
  const resolutionAt = resolution.hit_target_at || resolution.hit_stop_at || resolution.resolved_at
  const startedAt = new Date(row.scanned_at)
  const finishedAt = new Date(resolutionAt)
  const holdingMinutes = !Number.isNaN(startedAt.getTime()) && !Number.isNaN(finishedAt.getTime())
    ? Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 60_000))
    : null

  const maxHigh = finiteNumber(resolution._maxOptionHigh)
  const minLow = finiteNumber(resolution._minOptionLow)
  return {
    estimated_entry_price: round(estimatedEntry),
    estimated_exit_price: round(estimatedExit),
    estimated_entry_slippage_bps: entrySlippageBps,
    estimated_exit_slippage_bps: exitSlippageBps,
    estimated_fees_per_contract: round(feePerSide * 2, 2),
    gross_pnl_pct: round(grossPnlDollars / (estimatedEntry * 100)),
    estimated_net_pnl_pct: round(netPnlDollars / (estimatedEntry * 100)),
    realized_r_multiple: round(netPnlDollars / plannedRiskDollars),
    max_favorable_excursion_pct: maxHigh == null ? null : round((maxHigh - estimatedEntry) / estimatedEntry),
    max_adverse_excursion_pct: minLow == null ? null : round((minLow - estimatedEntry) / estimatedEntry),
    holding_minutes: holdingMinutes,
    measurement_version: 'execution_v1',
  }
}

module.exports = {
  buildProfitabilityMetrics,
  finiteNumber,
  DEFAULT_ENTRY_SLIPPAGE_BPS,
  DEFAULT_EXIT_SLIPPAGE_BPS,
  DEFAULT_FEE_PER_CONTRACT_SIDE,
}
