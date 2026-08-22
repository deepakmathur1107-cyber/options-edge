const { finiteNumber } = require('./profitabilityMetrics')

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * z)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return 0.5 * (1 + sign * erf)
}

function blackScholes({ spot, strike, years, volatility, rate = 0.043, dividendYield = 0, optionType }) {
  spot = finiteNumber(spot); strike = finiteNumber(strike); years = finiteNumber(years); volatility = finiteNumber(volatility)
  if (!(spot > 0) || !(strike > 0) || !(years > 0) || !(volatility > 0)) return null
  const sqrtT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (rate - dividendYield + volatility ** 2 / 2) * years) / (volatility * sqrtT)
  const d2 = d1 - volatility * sqrtT
  const discountR = Math.exp(-rate * years)
  const discountQ = Math.exp(-dividendYield * years)
  const pdf = Math.exp(-0.5 * d1 ** 2) / Math.sqrt(2 * Math.PI)
  const call = optionType === 'call'
  const price = call
    ? spot * discountQ * normalCdf(d1) - strike * discountR * normalCdf(d2)
    : strike * discountR * normalCdf(-d2) - spot * discountQ * normalCdf(-d1)
  const delta = call ? discountQ * normalCdf(d1) : discountQ * (normalCdf(d1) - 1)
  return {
    price: Math.max(0, price), delta,
    gamma: discountQ * pdf / (spot * volatility * sqrtT),
    vega: spot * discountQ * pdf * sqrtT / 100,
    theta: (-(spot * discountQ * pdf * volatility) / (2 * sqrtT) - rate * strike * discountR * (call ? normalCdf(d2) : -normalCdf(-d2)) + dividendYield * spot * discountQ * (call ? normalCdf(d1) : -normalCdf(-d1))) / 365,
  }
}

function expectedMovePct(volatility, dte) {
  const iv = finiteNumber(volatility); const days = finiteNumber(dte)
  return iv > 0 && days > 0 ? iv * Math.sqrt(days / 365) * 100 : null
}

module.exports = { blackScholes, expectedMovePct }
