// api/_lib/positionSizing.js
// Rewritten 2026-07-25 in response to the validation report's findings.
// Original version (commit 9df7db7) had real, confirmed bugs:
//   - maxContracts: 2.5 -> contracts: 2.5 (fractional contracts; options
//     contracts must be integers)
//   - accountEquity: Infinity produced non-finite internal values
//   - plannedAccountRiskPct: 1 (100% of account) was allowed with no cap
//   - sizing only from the planned stop assumed a clean 50%-premium exit
//     is always achievable — a gap, illiquid contract, or failed stop can
//     lose the ENTIRE premium, and the original version never modeled that
//     worst case at all
//
// Still deliberately separate from Setup Score and conviction, per the
// original strategy document's own instruction. Still pure — no I/O, no
// dependency on live signal data existing.

const DEFAULT_MAX_ACCOUNT_RISK_PCT = 0.02   // hard ceiling: never risk more than 2% of account on the planned stop, regardless of what's requested
const DEFAULT_MAX_PREMIUM_OUTLAY_PCT = 0.10 // hard ceiling: never commit more than 10% of account equity in premium, regardless of the risk-based sizing result

function invalid(reason, warnings) {
  return { contracts: 0, reason, plannedStopLoss: null, worstCasePremiumLoss: null,
    accountRiskBudget: null, premiumOutlay: null, premiumOutlayPct: null,
    bindingConstraint: null, warnings }
}

// calculateContracts(params) — pure function, no I/O, never throws.
// Contract count now satisfies BOTH budgets simultaneously, per the
// validation report's explicit requirement: the planned-stop risk budget
// AND the full-premium-outlay budget (a hard cap independent of the stop
// assumption, since the stop might not execute cleanly).
function calculateContracts({
  accountEquity,
  entryPremium,
  premiumStopLossPct,
  plannedAccountRiskPct,
  contractMultiplier = 100,
  maxContracts = Infinity,
  maxAccountRiskPct = DEFAULT_MAX_ACCOUNT_RISK_PCT,
  maxPremiumOutlayPct = DEFAULT_MAX_PREMIUM_OUTLAY_PCT,
  entrySpreadPct = null,
  maxSpreadPctAllowed = null,
} = {}) {
  const warnings = []

  // Number.isFinite on every numeric input that participates in the math —
  // rejects Infinity/-Infinity/NaN outright rather than letting them
  // propagate into a silently-corrupted result (the original bug:
  // accountEquity=Infinity produced non-finite internals that serialized
  // as null without ever being flagged as invalid input).
  const requiredFinite = { accountEquity, entryPremium, premiumStopLossPct, plannedAccountRiskPct, contractMultiplier, maxAccountRiskPct, maxPremiumOutlayPct }
  for (const [key, val] of Object.entries(requiredFinite)) {
    if (!Number.isFinite(val)) return invalid('invalid_input', [`${key} must be a finite number`])
  }
  if (maxContracts !== Infinity && !Number.isFinite(maxContracts)) {
    return invalid('invalid_input', ['maxContracts must be a finite number or Infinity'])
  }

  if (!(accountEquity > 0) || !(entryPremium > 0) || !(premiumStopLossPct > 0) || !(plannedAccountRiskPct > 0) || !(contractMultiplier > 0)) {
    return invalid('invalid_input', ['accountEquity, entryPremium, premiumStopLossPct, plannedAccountRiskPct, and contractMultiplier must all be positive'])
  }

  // Integer enforcement — options contracts are always whole numbers. The
  // original bug: maxContracts=2.5 passed straight through to
  // Math.min(rawContracts, maxContracts), producing contracts=2.5.
  if (!Number.isInteger(contractMultiplier) || contractMultiplier <= 0) {
    return invalid('invalid_input', ['contractMultiplier must be a positive integer'])
  }
  if (maxContracts !== Infinity && (!Number.isInteger(maxContracts) || maxContracts < 0)) {
    return invalid('invalid_input', ['maxContracts must be a non-negative integer or Infinity'])
  }

  if (maxSpreadPctAllowed != null && entrySpreadPct != null && entrySpreadPct > maxSpreadPctAllowed) {
    return invalid('spread_too_wide', [`entry spread ${entrySpreadPct}% exceeds max allowed ${maxSpreadPctAllowed}%`])
  }

  // Hard ceiling on requested account risk — the original bug allowed
  // plannedAccountRiskPct=1 (100% of the account) with no cap at all.
  // Silently capping (with a warning) rather than rejecting outright,
  // since a caller requesting more than the ceiling isn't necessarily an
  // error — just something to size down and flag.
  let effectiveRiskPct = plannedAccountRiskPct
  if (plannedAccountRiskPct > maxAccountRiskPct) {
    warnings.push(`Requested account risk ${(plannedAccountRiskPct * 100).toFixed(2)}% exceeds the ${(maxAccountRiskPct * 100).toFixed(2)}% hard ceiling — capped.`)
    effectiveRiskPct = maxAccountRiskPct
  }

  // Two independent per-contract cost figures, per the audit's explicit
  // requirement to separate them:
  //   plannedStopLossPerContract — the cost IF the stop executes cleanly
  //     at the target premium decline (the original, only, calculation).
  //   worstCaseLossPerContract — full premium loss, i.e. what actually
  //     happens if a gap, illiquid contract, or failed stop means the
  //     position can't be exited at the planned level at all. Sizing
  //     purely from the planned stop understates real worst-case exposure.
  const plannedStopLossPerContract = entryPremium * premiumStopLossPct * contractMultiplier
  const worstCaseLossPerContract = entryPremium * contractMultiplier // 100% of premium, if the stop never fills

  const accountRiskBudget = accountEquity * effectiveRiskPct
  const premiumOutlayBudget = accountEquity * maxPremiumOutlayPct

  // Contract count must satisfy BOTH budgets simultaneously (the planned-
  // stop risk budget AND the hard premium-outlay cap), plus any explicit
  // maxContracts — take the minimum of all three, whole numbers only.
  const contractsFromStopRisk = Math.floor(accountRiskBudget / plannedStopLossPerContract)
  const contractsFromPremiumOutlay = Math.floor(premiumOutlayBudget / (entryPremium * contractMultiplier))
  const contractsFromMaxCap = maxContracts === Infinity ? Infinity : Math.floor(maxContracts)

  const contracts = Math.min(contractsFromStopRisk, contractsFromPremiumOutlay, contractsFromMaxCap)

  let bindingConstraint
  if (contracts === contractsFromStopRisk && contracts <= contractsFromPremiumOutlay && contracts <= contractsFromMaxCap) {
    bindingConstraint = 'stop_risk_budget'
  } else if (contracts === contractsFromPremiumOutlay) {
    bindingConstraint = 'premium_outlay_cap'
  } else {
    bindingConstraint = 'max_contracts_cap'
  }

  if (!(contracts > 0)) {
    return {
      contracts: 0, reason: 'unaffordable', warnings,
      plannedStopLoss: Math.round(plannedStopLossPerContract * 100) / 100,
      worstCasePremiumLoss: Math.round(worstCaseLossPerContract * 100) / 100,
      accountRiskBudget: Math.round(accountRiskBudget * 100) / 100,
      premiumOutlay: 0, premiumOutlayPct: 0, bindingConstraint: null,
    }
  }

  const premiumOutlay = contracts * entryPremium * contractMultiplier
  return {
    contracts,
    reason: null,
    plannedStopLoss: Math.round(plannedStopLossPerContract * contracts * 100) / 100,
    worstCasePremiumLoss: Math.round(worstCaseLossPerContract * contracts * 100) / 100,
    accountRiskBudget: Math.round(accountRiskBudget * 100) / 100,
    premiumOutlay: Math.round(premiumOutlay * 100) / 100,
    premiumOutlayPct: Math.round((premiumOutlay / accountEquity) * 10000) / 100,
    bindingConstraint,
    warnings,
  }
}

module.exports = { calculateContracts, DEFAULT_MAX_ACCOUNT_RISK_PCT, DEFAULT_MAX_PREMIUM_OUTLAY_PCT }
