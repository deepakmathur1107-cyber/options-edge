const { classifyOptionMarketSession } = require('./marketCalendar')

function deriveScannerHealth({ lastObservedAt = null, now = new Date() } = {}) {
  const session = classifyOptionMarketSession(now)
  const scannerExpected = session === 'LIVE_REGULAR_SESSION'
  if (!lastObservedAt) {
    return {
      ok: !scannerExpected,
      status: scannerExpected ? 'degraded' : 'paused',
      detail: scannerExpected ? 'No completed scan is available during market hours' : 'Market is closed; scanner freshness is not expected',
      lastObservedAt: null,
    }
  }
  const ageMs = now.getTime() - new Date(lastObservedAt).getTime()
  const fresh = ageMs < 45 * 60 * 1000
  return {
    ok: scannerExpected ? fresh : true,
    status: scannerExpected ? (fresh ? 'operational' : 'degraded') : 'paused',
    detail: scannerExpected
      ? (fresh ? 'Latest scan is within the 45-minute health window' : 'Latest scan is older than the 45-minute health window')
      : 'Market is closed; scheduled scanning resumes during the next regular session',
    lastObservedAt,
  }
}

module.exports = { deriveScannerHealth }
