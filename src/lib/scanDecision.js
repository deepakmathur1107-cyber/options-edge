export function parseMarketNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function classifyScanDecision(signal = {}) {
  const exclusions = signal.qualityShortlist?.exclusions || []
  if (signal.qualityShortlist?.eligible) return 'shortlisted'
  if (exclusions.includes('PUT_STRATEGY_RESEARCH_ONLY') ||
      signal.lifecycleSummary?.lifecycle_status === 'RESEARCH') return 'research'
  if ((signal.hardBlocks || []).length || exclusions.includes('HARD_BLOCK')) return 'avoid'
  return Number(signal.score) >= 70 ? 'watch' : 'avoid'
}

export function executionQuality(signal = {}) {
  const bid = parseMarketNumber(signal.bid)
  const ask = parseMarketNumber(signal.ask)
  const mid = parseMarketNumber(signal.mid)
  const spreadPct = signal.qualityShortlist?.metrics?.spreadPct ??
    (mid > 0 && bid != null && ask != null ? ((ask - bid) / mid) * 100 : null)
  const volume = Number(signal.volume || 0)
  const openInterest = Number(signal.oi || 0)

  if (spreadPct == null) return { level: 'Unknown', spreadPct: null }
  if (spreadPct <= 8 && volume >= 100 && openInterest >= 500) return { level: 'Excellent', spreadPct }
  if (spreadPct <= 20 && volume >= 50 && openInterest >= 500) return { level: 'Acceptable', spreadPct }
  return { level: 'Poor', spreadPct }
}

export function marketAlignment(signal = {}, marketDirection = 'MIXED') {
  const isPut = /put/i.test(signal.tradeType || signal.option_type || '')
  const stockChange = parseMarketNumber(signal.chgPct)
  const stockConfirms = stockChange != null && (isPut ? stockChange <= -0.5 : stockChange >= 0.5)
  const direction = String(marketDirection || 'MIXED').toUpperCase()
  const marketConfirms = isPut ? direction === 'BEARISH' : direction === 'BULLISH'

  if (marketConfirms && stockConfirms) return { label: 'WITH MARKET', tone: 'positive' }
  if (!marketConfirms && stockConfirms && direction !== 'NEUTRAL' && direction !== 'MIXED') {
    return { label: isPut ? 'STOCK-SPECIFIC PUT' : 'STOCK-SPECIFIC CALL', tone: 'caution' }
  }
  if (marketConfirms) return { label: 'MARKET ALIGNED · STOCK UNCONFIRMED', tone: 'caution' }
  if (direction === 'NEUTRAL' || direction === 'MIXED') return { label: 'MARKET MIXED', tone: 'neutral' }
  return { label: 'COUNTER-MARKET', tone: 'negative' }
}

export function strategyEvidence(signal = {}) {
  const isPut = /put/i.test(signal.tradeType || signal.option_type || '')
  const isSwing = String(signal.tfKey || signal.timeframe || '').startsWith('Swing')
  if (isPut) return 'Bearish-regime put · collecting forward evidence'
  if (isSwing) return 'Liquid confirmed Swing call · early shadow evidence'
  return 'No promoted strategy evidence yet'
}

export function rejectionSummary(signals = []) {
  const counts = new Map()
  for (const signal of signals) {
    for (const reason of signal.qualityShortlist?.exclusions || []) {
      counts.set(reason, (counts.get(reason) || 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}
