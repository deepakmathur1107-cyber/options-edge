const DEFAULTS = Object.freeze({ length: 14, fastLength: 3, slowLength: 12, macdLength: 9 })

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null

function wilders(values, length) {
  const output = Array(values.length).fill(null)
  if (values.length < length) return output
  output[length - 1] = values.slice(0, length).reduce((sum, value) => sum + value, 0) / length
  for (let i = length; i < values.length; i++) output[i] = ((output[i - 1] * (length - 1)) + values[i]) / length
  return output
}

function ema(values, length) {
  const output = Array(values.length).fill(null)
  const alpha = 2 / (length + 1)
  let previous = null
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue
    previous = previous == null ? values[i] : alpha * values[i] + (1 - alpha) * previous
    output[i] = previous
  }
  return output
}

function rollingVolumeWeightedClose(bars, length) {
  return bars.map((_, index) => {
    if (index + 1 < length) return null
    const window = bars.slice(index + 1 - length, index + 1)
    const volume = window.reduce((sum, bar) => sum + bar.volume, 0)
    return volume > 0 ? window.reduce((sum, bar) => sum + bar.volume * bar.close, 0) / volume : null
  })
}

function calculateDmiVolumeConfirmation(inputBars, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const requiredBars = Math.max(settings.length * 2, settings.slowLength + settings.macdLength)
  const bars = (inputBars || []).map(bar => ({
    date: bar.date || bar.time || null, high: finite(bar.high), low: finite(bar.low),
    close: finite(bar.close), volume: finite(bar.volume),
  })).filter(bar => bar.high != null && bar.low != null && bar.close != null && bar.volume != null)
  if (bars.length < requiredBars) return { status: 'INSUFFICIENT_DATA', bars: bars.length, required_bars: requiredBars }

  const tr = [], plusDm = [], minusDm = [], signedVolume = []
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[i].high - bars[i].low); plusDm.push(0); minusDm.push(0); signedVolume.push(0); continue
    }
    const hiDiff = bars[i].high - bars[i - 1].high
    const loDiff = bars[i - 1].low - bars[i].low
    plusDm.push(hiDiff > loDiff && hiDiff > 0 ? hiDiff : 0)
    minusDm.push(loDiff > hiDiff && loDiff > 0 ? loDiff : 0)
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)))
    signedVolume.push(Math.sign(bars[i].close - bars[i - 1].close) * bars[i].volume)
  }

  const atr = wilders(tr, settings.length), plusAvg = wilders(plusDm, settings.length), minusAvg = wilders(minusDm, settings.length)
  const plusDi = atr.map((value, i) => value > 0 && plusAvg[i] != null ? 100 * plusAvg[i] / value : null)
  const minusDi = atr.map((value, i) => value > 0 && minusAvg[i] != null ? 100 * minusAvg[i] / value : null)
  const dx = plusDi.map((plus, i) => plus != null && minusDi[i] != null && plus + minusDi[i] > 0 ? 100 * Math.abs(plus - minusDi[i]) / (plus + minusDi[i]) : 0)
  const adx = wilders(dx, settings.length)
  const fast = rollingVolumeWeightedClose(bars, settings.fastLength), slow = rollingVolumeWeightedClose(bars, settings.slowLength)
  const macdValue = fast.map((value, i) => value != null && slow[i] != null ? value - slow[i] : null)
  const macdAverage = ema(macdValue, settings.macdLength)
  const vp = ema(signedVolume, settings.length), tv = ema(bars.map(bar => bar.volume), settings.length)
  const vzo = vp.map((value, i) => value != null && tv[i] > 0 ? 100 * value / tv[i] : null)
  const i = bars.length - 1, previous = i - 1
  const values = { plus: plusDi[i], minus: minusDi[i], adx: adx[i], priorAdx: adx[previous], macd: macdValue[i], macdAvg: macdAverage[i], vzo: vzo[i] }
  if (Object.values(values).some(value => value == null || !Number.isFinite(value))) return { status: 'INSUFFICIENT_DATA', bars: bars.length, required_bars: requiredBars }

  const adxRising = values.adx > values.priorAdx
  const bullishDmi = values.adx > 15 && adxRising && values.plus > values.minus && values.plus > plusDi[previous]
  const bearishDmi = values.adx > 15 && adxRising && values.minus > values.plus && values.minus > minusDi[previous]
  const bullishVolume = values.macd > 0 && values.macd > values.macdAvg && values.vzo > 0
  const bearishVolume = values.macd < 0 && values.macd < values.macdAvg && values.vzo < 0
  const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places
  return {
    status: 'MEASURED', version: 'dmi_volume_confirmation_v1', bar_interval: 'daily', bar_date: bars[i].date,
    length: settings.length, plus_di: round(values.plus), minus_di: round(values.minus), adx: round(values.adx), adx_rising: adxRising,
    slow_macd_value: round(values.macd, 4), slow_macd_average: round(values.macdAvg, 4), vzo: round(values.vzo),
    bullish_confirmed: bullishDmi && bullishVolume, bearish_confirmed: bearishDmi && bearishVolume,
    strong_bullish: values.plus > 40 || (values.vzo > 80 && values.plus > 30),
    strong_bearish: values.minus > 40 || (values.vzo < -80 && values.minus > 30),
  }
}

module.exports = { calculateDmiVolumeConfirmation, wilders, ema }
