const { calculateContracts } = require('./positionSizing')

function parseDisplayNumber(value) {
  if (value == null) return null
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function buildSizingForScanRow(row, prefs = {}) {
  const accountEquity = Number(prefs.account_equity)
  if (!(accountEquity > 0)) {
    return {
      configured: false,
      reason: 'account_equity_not_configured',
      disclaimer: 'Educational sizing only; not personalized financial advice.',
    }
  }

  const entryPremium = parseDisplayNumber(row.entry ?? row.mid)
  const stopPremium = parseDisplayNumber(row.stop)
  const bid = parseDisplayNumber(row.bid)
  const ask = parseDisplayNumber(row.ask)
  const premiumStopLossPct = entryPremium > 0 && stopPremium != null
    ? Math.max(0, Math.min(1, (entryPremium - stopPremium) / entryPremium))
    : null
  const entrySpreadPct = entryPremium > 0 && bid != null && ask != null
    ? ((ask - bid) / entryPremium) * 100
    : null

  if (!(entryPremium > 0) || !(premiumStopLossPct > 0)) {
    return {
      configured: true,
      contracts: 0,
      reason: 'signal_pricing_unavailable',
      disclaimer: 'Educational sizing only; not personalized financial advice.',
    }
  }

  return {
    configured: true,
    ...calculateContracts({
      accountEquity,
      entryPremium,
      premiumStopLossPct,
      plannedAccountRiskPct: Number(prefs.planned_account_risk_pct ?? 0.0025),
      maxPremiumOutlayPct: Number(prefs.max_premium_outlay_pct ?? 0.10),
      maxContracts: Number(prefs.max_position_contracts ?? 10),
      entrySpreadPct,
      maxSpreadPctAllowed: 25,
    }),
    disclaimer: 'Educational sizing only; not personalized financial advice.',
  }
}

module.exports = { parseDisplayNumber, buildSizingForScanRow }
