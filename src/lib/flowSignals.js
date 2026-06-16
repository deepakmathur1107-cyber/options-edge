// src/lib/flowSignals.js
// Analyses Tradier options chain to extract 4 independent directional signals.
// No external API needed — all data from Tradier chain.

export function computeFlowSignals(chain, price) {
  const calls = chain.filter(o => o.option_type === 'call')
  const puts  = chain.filter(o => o.option_type === 'put')

  // Signal 1: Ask-side sweep volume (dark pool proxy)
  const askSweep = (opts) => opts.reduce((s, o) => {
    const ask  = parseFloat(o.ask  || 0)
    const last = parseFloat(o.last || 0)
    const vol  = parseInt(o.volume || 0)
    return (ask > 0 && last >= ask * 0.97 && vol > 0) ? s + vol : s
  }, 0)
  const callSweeps = askSweep(calls)
  const putSweeps  = askSweep(puts)
  const sweepTotal = callSweeps + putSweeps
  const sweepRatio = sweepTotal > 10 ? callSweeps / sweepTotal : 0.5
  const flowBias   = sweepRatio > 0.6 ? 'bullish' : sweepRatio < 0.4 ? 'bearish' : 'neutral'

  // Signal 2: Put/Call volume ratio (today's activity)
  const callVol    = calls.reduce((s, o) => s + parseInt(o.volume || 0), 0)
  const putVol     = puts.reduce((s,  o) => s + parseInt(o.volume || 0), 0)
  const pcVolRatio = callVol > 0 ? putVol / callVol : 1
  const pcVolBias  = pcVolRatio < 0.7 ? 'bullish' : pcVolRatio > 1.4 ? 'bearish' : 'neutral'

  // Signal 3: Near-price OI ratio (institutional positioning, excludes deep OTM hedges)
  const nearCalls  = calls.filter(o => o.strike >= price * 0.85 && o.strike <= price * 1.20)
  const nearPuts   = puts.filter(o  => o.strike >= price * 0.80 && o.strike <= price * 1.15)
  const nearCallOI = nearCalls.reduce((s, o) => s + parseInt(o.open_interest || 0), 0)
  const nearPutOI  = nearPuts.reduce((s,  o) => s + parseInt(o.open_interest || 0), 0)
  const pcRatio    = nearCallOI > 0 ? nearPutOI / nearCallOI : 1
  const pcOIBias   = pcRatio < 0.8 ? 'bullish' : pcRatio > 1.3 ? 'bearish' : 'neutral'

  // Signal 4: GEX wall proximity (where dealers are positioned)
  const topCallWall = [...nearCalls].filter(o => o.strike > price)
    .sort((a, b) => (b.open_interest||0) - (a.open_interest||0))[0]
  const topPutWall  = [...nearPuts].filter(o => o.strike < price)
    .sort((a, b) => (b.open_interest||0) - (a.open_interest||0))[0]
  const nearestCallWall = topCallWall?.strike || price * 1.10
  const nearestPutWall  = topPutWall?.strike  || price * 0.90
  const callWallDist    = ((nearestCallWall - price) / price) * 100
  const putWallDist     = ((price - nearestPutWall)  / price) * 100
  const wallBias = putWallDist < callWallDist * 0.7 ? 'bullish'
                 : callWallDist < putWallDist * 0.7 ? 'bearish'
                 : 'neutral'

  // Consensus
  const biases    = [flowBias, pcVolBias, pcOIBias, wallBias]
  const bullCount = biases.filter(b => b === 'bullish').length
  const bearCount = biases.filter(b => b === 'bearish').length
  const direction = bullCount > bearCount ? 'call' : bearCount > bullCount ? 'put' : 'neutral'
  const consensus = Math.max(bullCount, bearCount)

  const signals = [
    {
      name: 'Options Flow',
      bias: flowBias,
      detail: sweepTotal < 10
        ? 'Low sweep volume — inconclusive'
        : `Call sweeps ${callSweeps} vs Put sweeps ${putSweeps}`,
      weight: 30,
    },
    {
      name: 'P/C Volume',
      bias: pcVolBias,
      detail: `Ratio ${pcVolRatio.toFixed(2)} — ${callVol} calls vs ${putVol} puts today`,
      weight: 25,
    },
    {
      name: 'P/C Open Interest',
      bias: pcOIBias,
      detail: `Near-price ratio ${pcRatio.toFixed(2)} — ${nearPutOI} puts vs ${nearCallOI} calls`,
      weight: 15,
    },
    {
      name: 'GEX Walls',
      bias: wallBias,
      detail: `Call wall $${nearestCallWall} (+${callWallDist.toFixed(1)}%) · Put wall $${nearestPutWall} (-${putWallDist.toFixed(1)}%)`,
      weight: 15,
    },
  ]

  return {
    flowBias, pcVolBias, pcOIBias, wallBias,
    consensus, direction, bullCount, bearCount,
    signals, pcRatio, pcVolRatio,
    callSweeps, putSweeps, callVol, putVol,
    nearestCallWall, nearestPutWall, callWallDist, putWallDist,
  }
}
