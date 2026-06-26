// api/_lib/occSymbol.js
//
// Builds OCC-format option symbols from signal_history's stored fields
// (ticker, option_type, primary_strike, expiry_raw) for use with Tradier's
// markets/history and markets/timesales endpoints.
//
// Format confirmed against a real, live Tradier call (June 2026):
//   AAPL260717P00275000
//   = AAPL (root) + 260717 (YYMMDD expiry) + P (put) + 00275000 (strike × 1000, 8 digits, zero-padded)

function buildOccSymbol(ticker, optionType, strike, expiryDate) {
  // expiryDate: Date object or 'YYYY-MM-DD' string (matches signal_history.expiry_raw)
  const d = expiryDate instanceof Date ? expiryDate : new Date(expiryDate + 'T12:00:00')
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const cp = (optionType || '').toLowerCase().startsWith('p') ? 'P' : 'C'
  // Strike × 1000, zero-padded to 8 digits. Tradier's own example
  // (AAPL220617C00270000) confirms this exact width — not derived, copied
  // directly from their docs page.
  const strikeNum = Math.round(parseFloat(strike) * 1000)
  const strikePadded = String(strikeNum).padStart(8, '0')
  return `${ticker.toUpperCase()}${yy}${mm}${dd}${cp}${strikePadded}`
}

module.exports = { buildOccSymbol }
