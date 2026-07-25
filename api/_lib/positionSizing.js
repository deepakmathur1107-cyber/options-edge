// api/_lib/positionSizing.js
// Added 2026-07-25. Position-sizing rules per the original strategy
// document (section 12) and the audit report (Phase 4) — kept as a
// separate, pure module deliberately, per the document's own instruction:
// "Keep this separate from Setup Score and conviction." This module never
// touches signal_history, never calls Tradier, never makes a scoring
// decision — it takes explicit inputs and returns a contract count, full
// stop. No dependency on live LIVE_AT_SIGNAL data existing, unlike the
// dashboard/promotion-calculator pieces — pure math is buildable and
// testable today regardless of what data has accumulated.
//
// Uses premium_stop_loss_pct / planned_account_risk_pct (the audit's
// Finding 8 correction), NOT the deprecated planned_risk_pct — risk here
// is explicitly account-equity-based, not option-premium-based, and
// conflating the two was exactly the bug the audit caught in the original
// document's field naming.

// calculateContracts(params) — pure function, no I/O, never throws (returns
// a { contracts: 0, reason } shape on any invalid/unaffordable input
// instead). Matches the audit's own formula exactly:
//   maximum_loss_per_contract = entry_premium * premium_stop_loss_pct * contract_multiplier
//   account_risk_budget = account_equity * planned_account_risk_pct
//   contracts = floor(account_risk_budget / maximum_loss_per_contract)
function calculateContracts({
  accountEquity,
  entryPremium,
  premiumStopLossPct,
  plannedAccountRiskPct,
  contractMultiplier = 100, // standard equity-option multiplier; parameterized per the audit's own spec, not hardcoded
  maxContracts = Infinity,
  entrySpreadPct = null, // optional — our own existing entry_spread_pct field
  maxSpreadPctAllowed = null, // optional liquidity gate
} = {}) {
  // Input validation — any invalid input returns 0 contracts with a reason,
  // never throws. A sizing function that crashes is worse than one that
  // conservatively returns zero.
  if (!(accountEquity > 0) || !(entryPremium > 0) || !(premiumStopLossPct > 0) || !(plannedAccountRiskPct > 0)) {
    return { contracts: 0, reason: 'invalid_input' }
  }
  if (maxSpreadPctAllowed != null && entrySpreadPct != null && entrySpreadPct > maxSpreadPctAllowed) {
    return { contracts: 0, reason: 'spread_too_wide' }
  }

  const maxLossPerContract = entryPremium * premiumStopLossPct * contractMultiplier
  if (!(maxLossPerContract > 0)) return { contracts: 0, reason: 'invalid_loss_calc' }

  const accountRiskBudget = accountEquity * plannedAccountRiskPct
  const rawContracts = Math.floor(accountRiskBudget / maxLossPerContract)
  const contracts = Math.min(rawContracts, maxContracts)

  if (contracts <= 0) {
    return { contracts: 0, reason: 'unaffordable',
      maxLossPerContract: Math.round(maxLossPerContract * 100) / 100,
      accountRiskBudget: Math.round(accountRiskBudget * 100) / 100 }
  }

  return {
    contracts,
    reason: null,
    maxLossPerContract: Math.round(maxLossPerContract * 100) / 100,
    totalMaxLoss: Math.round(contracts * maxLossPerContract * 100) / 100,
    accountRiskBudget: Math.round(accountRiskBudget * 100) / 100,
  }
}

module.exports = { calculateContracts }
