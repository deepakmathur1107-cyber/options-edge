// api/_lib/convictionScore.cjs
//
// CANONICAL conviction-scoring logic for naked (single-leg) options setups.
// This is the single source of truth — both the manual scan (src/App.jsx,
// via a one-line ESM wrapper at src/lib/convictionScore.js) and the cron/
// auto-scanner (api/_lib/scanLogic.js, via direct require) call this same
// function. Before this file existed, the identical scoring logic was
// hand-copied across three separate places (runScan in App.jsx, scanOneTicker
// in App.jsx, and scanTicker in scanLogic.js) and had already drifted in at
// least three confirmed ways:
//   1. The final hard-block cap was a flat 48% regardless of which block
//      fired, silently overriding the chasing-specific 42% cap if enough
//      other bonuses stacked on top of it.
//   2. Manual scan gave +8 for high volume during the first 30 min after
//      open; the cron/auto-scanner gave no volume credit at all in that
//      same window — same ticker, same moment, different score depending
//      on which path produced the result.
//   3. The volume-coherence bonus didn't exclude chasing setups, so a stock
//      already flagged "too late to chase" could still earn +12 for "high
//      volume confirms the move" — double-counting the same signal as both
//      a penalty and a bonus.
// All three are fixed here, once, instead of needing to be fixed three times
// and inevitably drifting again.
//
// SCOPE: naked single-leg options only. Spreads (buildSpreadResult) remain
// manual-scan-exclusive — this was a deliberate decision, not an oversight.
// The cron/auto-scanner has never supported spreads; bringing that parity
// is a real feature addition, not a scoring-correctness fix, and was kept
// out of this pass so a feature expansion doesn't get tangled up with (and
// risk obscuring the cause of) a correctness fix.
//
// Pure function: takes already-fetched data, returns the scoring result.
// No fetching, no await, no React/Vercel-specific code — safe to require()
// from a serverless function and import (via the wrapper) into a Vite
// bundle without modification.

/**
 * @param {Object} p
 * @param {number} p.price - current stock price
 * @param {number} p.chgPct - % change (already resolved via safeChgPct upstream)
 * @param {boolean} p.chgPctEstimated - true if chgPct was bid/ask-derived, not official tape
 * @param {string} p.optType - 'call' | 'put'
 * @param {number} p.iv - decimal IV (e.g. 0.35 for 35%), already NaN-guarded upstream
 * @param {number|null} p.delta
 * @param {number} p.volRatio - volume / average_volume
 * @param {number} p.strikeVolume - volume on the specific selected strike (not the underlying)
 * @param {number} p.pos52 - position within 52-week range, 0 (at low) to 1 (at high)
 * @param {number} p.dte - days to expiration
 * @param {number} p.spxChgToday
 * @param {number} p.ndxChgToday
 * @param {number|null} p.breakevenReqPct - signed % move required to reach break-even (null if not computable)
 * @param {boolean} p.isMorningWindow - true if within the first 30 min of the regular session
 * @param {{market_cap?:number, sector?:string, earnings_date?:string}|null} p.fundamentals
 * @param {Date} [p.now]
 * @returns {{score:number, reasons:string[], warnings:string[], hardBlocks:string[]}}
 */
function scoreConviction(p) {
  const {
    chgPct, chgPctEstimated, optType, iv, delta, volRatio, strikeVolume,
    pos52, dte, spxChgToday = 0, ndxChgToday = 0, breakevenReqPct,
    isMorningWindow, fundamentals, now = new Date(),
  } = p

  const ivPct = iv * 100
  const isIntraChasing = Math.abs(chgPct) > 2.0 && Math.abs(chgPct) <= 5.0
  const isEarningsGap  = Math.abs(chgPct) > 5.0
  const isChasing      = isIntraChasing
  const isHighIV        = iv > 0.55

  const marketFalling = spxChgToday < -0.5 && ndxChgToday < -0.5
  const marketRising  = spxChgToday > 0.5  && ndxChgToday > 0.5

  let score = 50
  const reasons = [], warnings = [], hardBlocks = []
  // Tracks the lowest cap implied by any hard block that fires below — fix
  // #1. Each block records its OWN required ceiling instead of all of them
  // collapsing to one flat constant at the end.
  let hardBlockCap = null
  const applyCap = (cap) => { hardBlockCap = hardBlockCap === null ? cap : Math.min(hardBlockCap, cap) }

  if (isMorningWindow) {
    warnings.push('🔔 MARKET OPEN — First 30 min are volatile. Spreads are wider, volume signals are unreliable, and IV is inflated. If conviction is high, size smaller than normal and use a limit order at mid or better.')
  }
  if (chgPctEstimated) {
    warnings.push(`🌅 PRE-MARKET ESTIMATE — official change% isn't live yet before the bell, so the ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move (and the direction/chasing checks based on it) is estimated from the current bid/ask vs. yesterday's close, not a confirmed trade. Pre-market spreads are wide — treat this as directional context, not a precise number, until regular trading begins.`)
  }
  if (isChasing) {
    hardBlocks.push(`🚨 Already ${chgPct>0?'+':''}${chgPct.toFixed(1)}% today — buying into this move means paying inflated premium. ✅ Fix: set a limit alert 1–2% below current price and enter on the pullback, or reduce size to 25% of normal.`)
    applyCap(42)
  }
  if (isHighIV) {
    hardBlocks.push(`🔥 IV ${ivPct.toFixed(0)}% elevated — buying premium is expensive right now. ✅ Fix: switch to a Credit Spread or Iron Condor to sell the inflated IV instead, or wait for IV to drop below 45%.`)
    applyCap(48)
  }

  // ── Earnings gap handling — >5% gap = catalyst, not intraday drift ──────────
  if (isEarningsGap) {
    const gapOpt = chgPct > 0 ? 'call' : 'put'
    if (optType === gapOpt) {
      score += 15
      reasons.push(`Earnings/news gap ${chgPct>0?'+':''}${chgPct.toFixed(1)}% — catalyst confirmed`)
      warnings.push('⚡ GAP PLAY — Premium is expanded. Size at 50% of normal. Enter on a small pullback or consolidation. Target 50–80% of premium.')
    } else {
      score -= 20
      warnings.push(`Trading AGAINST the gap — stock moved ${chgPct.toFixed(1)}% and you are playing the other direction. Very high risk.`)
    }
  }

  // ── Market regime ────────────────────────────────────────────────────────
  if (marketFalling && optType === 'call') {
    score -= 12
    warnings.push(`Market headwind — SPX ${spxChgToday.toFixed(1)}% / NDX ${ndxChgToday.toFixed(1)}% today. Calls face drag when index is falling.`)
  } else if (marketRising && optType === 'put') {
    score -= 10
    warnings.push(`Market headwind — SPX ${spxChgToday.toFixed(1)}% / NDX ${ndxChgToday.toFixed(1)}% today. Puts face drag when index is rising.`)
  } else if (marketRising && optType === 'call') {
    score += 6; reasons.push(`Market tailwind — SPX ${spxChgToday.toFixed(1)}%`)
  } else if (marketFalling && optType === 'put') {
    score += 6; reasons.push(`Market tailwind — SPX ${spxChgToday.toFixed(1)}% falling`)
  }

  // ── IV environment ───────────────────────────────────────────────────────
  if (iv >= 0.20 && iv <= 0.40) { score += 12; reasons.push(`IV ${ivPct.toFixed(0)}% — cheap premium`) }
  else if (iv > 0.40 && iv <= 0.55) { score += 6; reasons.push(`IV ${ivPct.toFixed(0)}% — moderate`) }
  else if (iv > 0.55 && iv <= 0.65) { score -= 8; warnings.push(`IV ${ivPct.toFixed(0)}% elevated — overpaying`) }
  else if (iv > 0.65) { score -= 15; warnings.push(`IV ${ivPct.toFixed(0)}% HIGH — move already priced in`) }

  // ── Volume + price coherence ─────────────────────────────────────────────
  // Fix #2: morning window gets NO volume credit at all (matches the warning
  // text already telling the user "volume signals are unreliable" — scoring
  // on a signal you're simultaneously telling the user not to trust was the
  // actual inconsistency, not which specific number to award).
  // Fix #3: coherence bonus excludes chasing setups — a stock already
  // flagged "too late, already moved" shouldn't also earn a volume bonus
  // for confirming the same move you just penalized it for.
  if (!isMorningWindow) {
    const volPriceCoherent  = volRatio >= 1.5 && Math.abs(chgPct) >= 1.0 && !isChasing
    const volPriceDivergent = volRatio >= 3.0 && Math.abs(chgPct) < 0.8
    if (volPriceDivergent) {
      score -= 8
      warnings.push(`Vol ${volRatio.toFixed(1)}x but stock barely moved (${chgPct.toFixed(1)}%) — likely institutional roll or distribution, not directional flow`)
    } else if (volPriceCoherent) {
      score += 12
      reasons.push(`Vol ${volRatio.toFixed(1)}x avg with ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move — coherent bullish signal`)
    } else if (volRatio >= 1.5 && !isChasing) {
      score += 4
      warnings.push(`Vol ${volRatio.toFixed(1)}x avg but price only ${chgPct.toFixed(1)}% — confirm this is directional before entering`)
    } else if (volRatio < 0.8) {
      score -= 8; warnings.push(`Low volume ${volRatio.toFixed(1)}x — weak conviction`)
    }
  } else {
    warnings.push('🔔 Market open — volume signals less reliable in first 30 min')
  }

  // ── Price momentum (skipped for chasing/earnings-gap — handled above) ──────
  if (isIntraChasing) {
    warnings.push(`Already moved ${chgPct>0?'+':''}${chgPct.toFixed(1)}% intraday without a specific catalyst — chasing`)
  } else if (!isEarningsGap) {
    if (Math.abs(chgPct) >= 1.5 && Math.abs(chgPct) <= 2.0) { score += 8; reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% — clean directional move`) }
    else if (Math.abs(chgPct) >= 0.8 && Math.abs(chgPct) < 1.5) { score += 4; reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`) }
  }

  // ── Delta quality ─────────────────────────────────────────────────────────
  if (delta && Math.abs(delta) >= 0.35 && Math.abs(delta) <= 0.55) { score += 10; reasons.push(`Delta ${delta.toFixed(2)} ideal`) }
  else if (delta && Math.abs(delta) >= 0.25 && Math.abs(delta) <= 0.65) { score += 5; reasons.push(`Delta ${delta.toFixed(2)}`) }

  // ── Strike-specific liquidity ─────────────────────────────────────────────
  if (!isMorningWindow && strikeVolume > 500) { score += 5; reasons.push(`${strikeVolume} contracts on strike`) }
  else if (!isMorningWindow && strikeVolume < 50) { score -= 5; warnings.push(`Only ${strikeVolume||0} contracts on strike — thin liquidity, use limit orders`) }

  // ── 52-week trend ─────────────────────────────────────────────────────────
  if (optType === 'call') {
    if (pos52 > 0.80) { score += 8; reasons.push('Near 52w high — uptrend tailwind') }
    else if (pos52 > 0.65) { score += 4 }
    else if (pos52 < 0.20) { score -= 8; warnings.push('Near 52w low — calls against trend, avoid') }
  } else {
    if (pos52 < 0.20) { score += 8; reasons.push('Near 52w low — downtrend tailwind for puts') }
    else if (pos52 < 0.35) { score += 4 }
    else if (pos52 > 0.80) { score -= 8; warnings.push('Near 52w high — puts against trend, trading in uptrend') }
  }

  // ── DTE / IV incompatibility ──────────────────────────────────────────────
  if (dte < 14 && iv > 0.45) { score -= 12; warnings.push(`DTE ${dte} + IV ${ivPct.toFixed(0)}% = theta+IV crush. Need 21+ DTE at this IV.`) }
  else if (dte >= 21 && dte <= 60) { score += 5; reasons.push(`${dte} DTE — good buffer`) }

  // ── Break-even reality ────────────────────────────────────────────────────
  if (breakevenReqPct != null) {
    const beAbs = Math.abs(breakevenReqPct)
    const beDir = breakevenReqPct < 0 ? 'down' : 'up'
    if (beAbs > 5.0) { score -= 14; warnings.push(`Break-even requires ${breakevenReqPct<0?'-':'+'}${beAbs.toFixed(1)}% move ${beDir} — low probability`) }
    else if (beAbs > 3.5) { score -= 7; warnings.push(`Break-even requires ${breakevenReqPct<0?'-':'+'}${beAbs.toFixed(1)}% move ${beDir} — needs catalyst`) }
    else if (beAbs > 0 && beAbs <= 2.5) { score += 5; reasons.push(`Break-even only ${breakevenReqPct<0?'-':'+'}${beAbs.toFixed(1)}% away — realistic target`) }
  }

  // ── Fundamentals ──────────────────────────────────────────────────────────
  if (fundamentals) {
    if (fundamentals.market_cap && fundamentals.market_cap > 100_000_000_000) {
      score += 3; reasons.push(`Large-cap (${fundamentals.sector || '—'})`)
    }
    if (fundamentals.earnings_date) {
      const earnDays = Math.round((new Date(fundamentals.earnings_date) - now) / (1000*60*60*24))
      if (earnDays >= 0 && earnDays <= 7) {
        warnings.push(`⚠️ Earnings in ${earnDays}d — IV crush risk after event`)
        if (!isEarningsGap) score -= 10
      } else if (earnDays > 7 && earnDays <= 21) {
        warnings.push(`Earnings in ${earnDays}d — factor into DTE choice`)
      }
    }
  }

  // ── No-catalyst cap ───────────────────────────────────────────────────────
  const hasRealSignal = Math.abs(chgPct) >= 1.5 || pos52 > 0.85 || isEarningsGap
  if (!hasRealSignal && hardBlocks.length === 0) {
    score = Math.min(score, 72)
    warnings.push('No identifiable catalyst — technical signals confirm structure but cannot predict direction. Know the specific WHY before entering.')
  }

  // ── Final clamp — apply the SPECIFIC cap implied by whichever hard block(s)
  // fired (fix #1), not a flat constant that could let a 42%-capped chasing
  // setup drift back up to 48% if enough other bonuses stacked on top. ──
  if (hardBlockCap !== null) score = Math.min(score, hardBlockCap)
  score = Math.min(95, Math.max(20, score))

  return { score, reasons, warnings, hardBlocks }
}

module.exports = { scoreConviction }
