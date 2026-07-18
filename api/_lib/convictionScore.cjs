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
 * @param {string} [p.tf] - timeframe key matching TF_CONFIG (e.g. 'Quick (5–14 DTE)', 'LEAP (90–180 DTE)').
 *   Selects a delta-quality / DTE weighting profile from TF_WEIGHT_PROFILES. Falls back to the
 *   'Swing (21–45 DTE)' profile (= original, unweighted behavior) if omitted or unrecognized —
 *   existing callers that don't pass tf get byte-identical scoring to before this param existed.
 * @param {string|null} [p.gexSign] - accepted for caller compatibility (scanLogic.js computes it),
 *   but NOT used directionally here — see comment at the gamma-weighted-strike-conviction block
 *   below for why optType-derived sign isn't a real dealer-positioning signal.
 * @param {number|null} [p.gexMagnitude01] - gamma-weighted-OI magnitude at the selected strike,
 *   normalized 0–1 upstream (gexNorm in scanLogic.js). Used as a strike-quality/conviction
 *   confirmation signal (high concentration = not a thin/orphan strike), not a directional one.
 * @param {('at_support'|'at_resistance'|'mid_range')|null} [p.srPosition] - from srLevels.js
 * @param {number|null} [p.srDistPct] - % distance to the relevant near level (whichever srPosition refers to), always positive
 * @param {Date} [p.now]
 * @returns {{score:number, reasons:string[], warnings:string[], hardBlocks:string[]}}
 */

// TF_WEIGHT_PROFILES: scales the two blocks that genuinely behave differently by
// horizon — delta-quality band and DTE/IV tolerance. A LEAP buyer wants higher
// delta (closer to stock-replacement) and tolerates high IV less, since vega
// exposure compounds over months; a scalp/quick trade cares more about getting
// delta-quality right *for that band* but DTE/IV crush isn't really a concept
// at 5-14 days the way it is at 90+. Deliberately NOT a full second scoring
// table (that was the rejected "4 separate models" proposal) — same blocks,
// same formula shape, just different multipliers/bands per timeframe so one
// function stays the single source of truth.
// pos52Mult (added 2026-07-17): dampens the 52w-proximity TAILWIND bonus
// specifically for Quick. Evidence: win-rate analysis on 999 resolved Quick
// trades showed 52w-tagged trades underperforming non-52w trades by ~5pts
// (31.3% vs 36.6%, n=313 vs 686) — and 52w-tagged trades are disproportionately
// concentrated in the 85+ score bucket (63.6% vs 26-33% in lower buckets),
// contributing to that bucket's 25.4% win rate (vs 50% breakeven for Quick).
// NOT applied to Swing/LEAP/Deep LEAP: we don't have equivalent per-timeframe
// evidence there yet — Swing's score was found to be non-predictive across
// ALL buckets in the same analysis, a different (and currently unfixed)
// problem this multiplier does not address. Also NOT applied to the
// against-trend PENALTY branches (calls-near-52w-low, puts-near-52w-high) —
// only evidenced against the bonus/tailwind case.
// Deliberately conservative (0.6, ~40% reduction) rather than zeroing the
// term out: the analysis found a real but partial effect (doesn't fully
// explain the 85+ bucket's underperformance on its own), so this is a
// dial-back, not a claim the term is worthless. Revisit alongside the still-
// unexplained residual gap once more resolved data accumulates.
// counterTrendPenalty (added 2026-07-18): dampens setups fighting the long-
// term (SMA50/SMA200) trend — a PUT when trend='bullish', or a CALL when
// trend='bearish'. Evidence: a clean natural-experiment on Swing puts (same
// entry cohort, June 22/29, split only by hold duration) showed win rate
// roughly HALVE from Quick's 5-14 day hold (34-36%) to Swing's 21-45 day
// hold (18-24%) — consistent with short-term-correct bearish calls getting
// overrun by a longer-term bullish grind the longer they're held. Quick
// shows ~0 duration effect on the SAME cohort, hence 0 penalty there.
// Values scale with duration under the same "trend has more time to
// dominate" logic, but LEAP/Deep LEAP values are NOT independently evidenced
// yet (no resolved LEAP/Deep LEAP sample large enough to check) — treated as
// a reasonable extrapolation of the confirmed Swing effect, not equally
// certain. Revisit magnitude once the backtest endpoint (trend-backtest.js)
// and/or real forward data validates it — this is a first-pass value, not
// tuned/optimized.
const TF_WEIGHT_PROFILES = {
  'Quick (5–14 DTE)':       { deltaIdealLo: 0.35, deltaIdealHi: 0.55, deltaMult: 1.0, dteIvPenaltyMult: 0.6, pos52Mult: 0.6, counterTrendPenalty: 0 },
  'Swing (21–45 DTE)':      { deltaIdealLo: 0.35, deltaIdealHi: 0.55, deltaMult: 1.0, dteIvPenaltyMult: 1.0, pos52Mult: 1.0, counterTrendPenalty: 12 },
  'LEAP (90–180 DTE)':      { deltaIdealLo: 0.60, deltaIdealHi: 0.80, deltaMult: 1.0, dteIvPenaltyMult: 1.4, pos52Mult: 1.0, counterTrendPenalty: 15 },
  'Deep LEAP (180–365 DTE)':{ deltaIdealLo: 0.70, deltaIdealHi: 0.90, deltaMult: 1.0, dteIvPenaltyMult: 1.6, pos52Mult: 1.0, counterTrendPenalty: 18 },
}
const DEFAULT_TF_PROFILE = TF_WEIGHT_PROFILES['Swing (21–45 DTE)']

function scoreConviction(p) {
  const {
    chgPct, chgPctEstimated, optType, iv, delta, volRatio, strikeVolume,
    pos52, dte, spxChgToday = 0, ndxChgToday = 0, breakevenReqPct,
    isMorningWindow, fundamentals, now = new Date(), tf,
    gexSign = null, gexMagnitude01 = null, srPosition = null, srDistPct = null,
    trendDirection = 'unknown',
  } = p

  const tfProfile = TF_WEIGHT_PROFILES[tf] || DEFAULT_TF_PROFILE

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
  // gapAligned tracked here and reused below (52w trend, SR structure) — a
  // >5% gap will very often mechanically push pos52 to an extreme and/or
  // through a support/resistance level in the SAME move. When that happens,
  // those aren't independent confirmations of conviction, they're mostly
  // the same single event described three different ways — confirmed on
  // the CRM $165P case (2026-07-09): raw score hit 105 pre-cap from
  // earnings-gap (+15) + near-52w-low (+8) + resistance-rejection (+6)
  // all firing off what was fundamentally one overnight move. Only dampens
  // the TAILWIND/bonus branches below, not the against-trend warning
  // branches — a gap that contradicts the 52w/SR structure is still a
  // genuinely independent, still-informative signal worth full weight.
  let gapAligned = false
  if (isEarningsGap) {
    const gapOpt = chgPct > 0 ? 'call' : 'put'
    if (optType === gapOpt) {
      gapAligned = true
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

  // ── Long-term trend (SMA50/SMA200) ──────────────────────────────────────
  // Distinct from the same-day "Market regime" block above: that's TODAY's
  // single-day move, this is the multi-week/multi-month trend the position's
  // HOLDING PERIOD is being entered into. See TF_WEIGHT_PROFILES comment for
  // the evidence (clean natural-experiment on Swing puts). Dampens, never
  // hard-blocks — a well-timed reversal call against the trend can still be
  // right, this just reflects that it needs to overcome a real structural
  // headwind the longer it's held. 'unknown'/'mixed' trend intentionally
  // applies no penalty — don't penalize on a signal we're not confident about.
  const counterTrend =
    (optType === 'call' && trendDirection === 'bearish') ||
    (optType === 'put'  && trendDirection === 'bullish')
  if (counterTrend && tfProfile.counterTrendPenalty > 0) {
    score -= tfProfile.counterTrendPenalty
    warnings.push(
      `Counter-trend — underlying is in a long-term ${trendDirection} trend (SMA50/SMA200), ` +
      `${optType === 'put' ? 'puts' : 'calls'} face a structural headwind the longer this ${tf} position is held.`
    )
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
  // Fix (gap-stacking, part 2): this branch was missed by the original
  // gapAligned dampening pass (d3373f4, 2026-07-10), which only touched
  // 52w-trend and S/R. Confirmed live 2026-07-15 on NTAP/MTB/BIIB — a >5%
  // earnings gap almost always ALSO produces elevated volume in the
  // aligned direction, so this +12 "coherent signal" bonus was firing at
  // full weight on top of the +15 gap bonus nearly every time, for the
  // same reason 52w/SR needed dampening: it's not an independent
  // confirmation, it's the same single gap event described a third way.
  // Same treatment as the existing 52w/SR dampening — bonus branch scaled
  // down when gapAligned, divergent/against-trend branches left at full
  // weight since those ARE still independently informative.
  if (!isMorningWindow) {
    const moveHelpsPosition = (optType === 'call' && chgPct > 0) || (optType === 'put' && chgPct < 0)
    const volPriceCoherent  = volRatio >= 1.5 && Math.abs(chgPct) >= 1.0 && !isChasing && moveHelpsPosition
    const volPriceDivergent = volRatio >= 3.0 && Math.abs(chgPct) < 0.8
    if (volPriceDivergent) {
      score -= 8
      warnings.push(`Vol ${volRatio.toFixed(1)}x but stock barely moved (${chgPct.toFixed(1)}%) — likely institutional roll or distribution, not directional flow`)
    } else if (volPriceCoherent) {
      const bonus = gapAligned ? 4 : 12
      score += bonus
      reasons.push(gapAligned ? `Vol ${volRatio.toFixed(1)}x avg — likely the same move as the gap above, partial credit` : `Vol ${volRatio.toFixed(1)}x avg with ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move — coherent ${chgPct>0?'bullish':'bearish'} signal`)
    } else if (volRatio >= 1.5 && Math.abs(chgPct) >= 1.0 && !isChasing && !moveHelpsPosition) {
      warnings.push(`Vol ${volRatio.toFixed(1)}x avg with ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move — but that move is AGAINST this ${optType}, not confirming it`)
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
    const moveHelpsPosition = (optType === 'call' && chgPct > 0) || (optType === 'put' && chgPct < 0)
    if (moveHelpsPosition) {
      if (Math.abs(chgPct) >= 1.5 && Math.abs(chgPct) <= 2.0) { score += 8; reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% — clean directional move`) }
      else if (Math.abs(chgPct) >= 0.8 && Math.abs(chgPct) < 1.5) { score += 4; reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`) }
    } else if (Math.abs(chgPct) >= 0.8) {
      warnings.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% move today is AGAINST this ${optType} — today's price action doesn't support the thesis`)
    }
  }

  // ── Delta quality ─────────────────────────────────────────────────────────
  // Ideal band shifts by timeframe (tfProfile): Quick/Swing want ~0.35-0.55
  // (balanced premium buyer), LEAP/Deep LEAP want 0.60-0.90 (stock-replacement,
  // less extrinsic decay risk). Falls back to the Swing band if tf is unset.
  {
    const lo = tfProfile.deltaIdealLo, hi = tfProfile.deltaIdealHi
    const widerLo = Math.max(0.10, lo - 0.10), widerHi = Math.min(0.95, hi + 0.10)
    if (delta && Math.abs(delta) >= lo && Math.abs(delta) <= hi) {
      score += 10 * tfProfile.deltaMult; reasons.push(`Delta ${delta.toFixed(2)} ideal for ${tf || 'this'} timeframe`)
    } else if (delta && Math.abs(delta) >= widerLo && Math.abs(delta) <= widerHi) {
      score += 5 * tfProfile.deltaMult; reasons.push(`Delta ${delta.toFixed(2)}`)
    }
  }

  // ── Strike-specific liquidity ─────────────────────────────────────────────
  if (!isMorningWindow && strikeVolume > 500) { score += 5; reasons.push(`${strikeVolume} contracts on strike`) }
  else if (!isMorningWindow && strikeVolume < 50) { score -= 5; warnings.push(`Only ${strikeVolume||0} contracts on strike — thin liquidity, use limit orders`) }

  // ── 52-week trend ─────────────────────────────────────────────────────────
  // Tailwind branches (bonus) are dampened when gapAligned — see comment on
  // gapAligned above. Against-trend branches (warning/penalty) are left at
  // full weight in every case: a gap that contradicts existing 52w
  // structure is still genuinely informative, not redundant.
  if (optType === 'call') {
    if (pos52 > 0.80) {
      const bonus = Math.round((gapAligned ? 3 : 8) * tfProfile.pos52Mult)
      score += bonus
      reasons.push(gapAligned ? 'Near 52w high — likely the same move as the gap above, partial credit' : 'Near 52w high — uptrend tailwind')
    }
    else if (pos52 > 0.65) { score += Math.round((gapAligned ? 2 : 4) * tfProfile.pos52Mult) }
    else if (pos52 < 0.20) { score -= 8; warnings.push('Near 52w low — calls against trend, avoid') }
  } else {
    if (pos52 < 0.20) {
      const bonus = Math.round((gapAligned ? 3 : 8) * tfProfile.pos52Mult)
      score += bonus
      reasons.push(gapAligned ? 'Near 52w low — likely the same move as the gap above, partial credit' : 'Near 52w low — downtrend tailwind for puts')
    }
    else if (pos52 < 0.35) { score += Math.round((gapAligned ? 2 : 4) * tfProfile.pos52Mult) }
    else if (pos52 > 0.80) { score -= 8; warnings.push('Near 52w high — puts against trend, trading in uptrend') }
  }

  // ── Gamma-weighted strike conviction ──────────────────────────────────────
  // CORRECTED framing: approxGEX's sign in scanLogic.js is just optType
  // (call=+1, put=-1) times a gamma-weighted-OI magnitude — it is NOT net
  // dealer positioning (that would require aggregating both calls AND puts
  // at the strike with assumptions about which side market makers are short,
  // data this function doesn't have). For a single already-selected contract,
  // gexSign is always positive for a call and always negative for a put by
  // construction — using it as a directional "amplifies vs. dampens" signal
  // would just reward/penalize every call identically and every put
  // identically, which isn't a real signal at all. Caught and corrected
  // before shipping — see conversation history if this needs re-deriving.
  //
  // What gexMagnitude01 DOES legitimately tell you: this specific strike has
  // meaningfully more open-interest-weighted gamma than the chain average —
  // i.e. it's a strike other traders have actually concentrated into, not a
  // thin/orphan strike that happened to be closest to the target price. That's
  // a real, if modest, conviction signal: confirms strike quality beyond what
  // scoreStrike's raw OI/volume ratio already captures, since it also folds
  // in IV and delta. Treated here as a small same-direction-for-both-sides
  // bonus, not a call-vs-put directional tilt.
  if (gexMagnitude01 != null && gexMagnitude01 > 0.4) {
    const bonus = Math.round(5 * gexMagnitude01)
    score += bonus
    reasons.push(`High open-interest concentration at this strike — not a thin/orphan strike`)
  }

  // ── Support/resistance structure ──────────────────────────────────────────
  // srPosition/srDistPct come from srLevels.js (swing highs/lows + Fib + pivots,
  // already computed and shown in the UI info panel today, but never fed into
  // the score). A call bought right at overhead resistance, or a put bought
  // right at support, is buying into the level most likely to reject the move —
  // the same "late/against structure" problem the chasing/52w checks catch from
  // other angles, but neither of those sees the *level* itself.
  if (srPosition && srDistPct != null) {
    if (optType === 'call') {
      if (srPosition === 'at_resistance') {
        score -= 10
        warnings.push(`Price is at/near resistance (${srDistPct.toFixed(1)}% away) — calls face the level most likely to reject this move`)
      } else if (srPosition === 'at_support') {
        score += gapAligned ? 3 : 6
        reasons.push(gapAligned ? `Bouncing off support (${srDistPct.toFixed(1)}% away) — likely the same move as the gap above, partial credit` : `Bouncing off support (${srDistPct.toFixed(1)}% away) — room to run before the next resistance`)
      }
    } else {
      if (srPosition === 'at_support') {
        score -= 10
        warnings.push(`Price is at/near support (${srDistPct.toFixed(1)}% away) — puts face the level most likely to bounce`)
      } else if (srPosition === 'at_resistance') {
        score += gapAligned ? 3 : 6
        reasons.push(gapAligned ? `Rejecting off resistance (${srDistPct.toFixed(1)}% away) — likely the same move as the gap above, partial credit` : `Rejecting off resistance (${srDistPct.toFixed(1)}% away) — room to fall before the next support`)
      }
    }
  }

  // ── DTE / IV incompatibility ──────────────────────────────────────────────
  // Penalty scaled by dteIvPenaltyMult: LEAP/Deep LEAP carry meaningful vega
  // over months, so paying high IV up front matters more for them than for a
  // 5-14 day Quick play where theta dominates and IV crush has less runway to
  // hurt. dte<14 trigger condition itself is unchanged — Quick trades sit right
  // at that boundary already and shouldn't get an easier pass on the trigger,
  // only on the size of the penalty if it fires.
  if (dte < 14 && iv > 0.45) {
    score -= Math.round(12 * tfProfile.dteIvPenaltyMult)
    warnings.push(`DTE ${dte} + IV ${ivPct.toFixed(0)}% = theta+IV crush. Need 21+ DTE at this IV.`)
  }
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
  // FIX (symmetry): originally only checked pos52 > 0.85 (near 52w HIGH), which
  // only ever counts as a "real signal" for calls. A flat-on-the-day stock sitting
  // at a fresh 52w LOW — a textbook bearish continuation setup — never tripped
  // hasRealSignal and got capped at 72 regardless of how good the put thesis was.
  // Catalyst detection must check both sides of the range, not just the upside.
  const hasRealSignal = Math.abs(chgPct) >= 1.5 || pos52 > 0.85 || pos52 < 0.15 || isEarningsGap
  if (!hasRealSignal && hardBlocks.length === 0) {
    score = Math.min(score, 72)
    warnings.push('No identifiable catalyst — technical signals confirm structure but cannot predict direction. Know the specific WHY before entering.')
  }

  // ── Final clamp — apply the SPECIFIC cap implied by whichever hard block(s)
  // fired (fix #1), not a flat constant that could let a 42%-capped chasing
  // setup drift back up to 48% if enough other bonuses stacked on top. ──
  if (hardBlockCap !== null) score = Math.min(score, hardBlockCap)

  // 95 ceiling — deliberate, not arbitrary: this is a heuristic conviction
  // score (technicals + IV + breakeven math + catalyst proxies), not a
  // guarantee, and a UI that can show "100" invites a false sense of
  // certainty the underlying signal can't back up. Reserving the top 5
  // points is a small, deliberate "even our best setup isn't certain" tell.
  // Previously this clamp fired silently (no warning, unlike the 72 cap
  // just above) -- confirmed live: ~1% of all scans hit this ceiling
  // (71 of ~7,225 in a 4-day window), common enough that silent clamping
  // meant a true 95 and a clamped-down 130 looked identical to the user
  // with no way to tell which. Warning added for the same transparency
  // reason the no-catalyst cap already has one.
  const preCeilingScore = score
  score = Math.min(95, Math.max(20, score))
  if (preCeilingScore > 95) {
    warnings.push(`Score capped at 95 — this setup scored even higher (${preCeilingScore}) before the ceiling, but conviction scores are capped to avoid implying certainty.`)
  }

  return { score, reasons, warnings, hardBlocks }
}

// pickBetterSide: given a fully-built scoreConviction result for the call side
// and the put side (each already scored against ITS OWN selected contract —
// different strike/IV/delta per side, since the best call strike and best put
// strike are rarely the same contract), decides which side wins and by how much.
//
// Deliberately NOT responsible for building either side's contract data —
// that requires buildNakedResult (lives in scanLogic.js, needs the live chain),
// and duplicating contract selection here would just recreate the
// three-copies-drifted problem this file already exists to prevent. Callers
// (scanTicker in scanLogic.js, runScan/scanOneTicker in App.jsx) build both
// sides' td/iv/delta/breakeven from the real chain, score each through
// scoreConviction, and pass both finished results in here to decide.
//
// minGapToPreferDirection: if the two sides are within this many points of
// each other, this is a low-conviction/ambiguous setup either way — caller can
// use isClose to decide whether to surface it as lower-confidence or skip it,
// rather than silently presenting whichever side happened to score one point
// higher as if it were a clear signal.
function pickBetterSide(callResult, putResult, { minGapToPreferDirection = 6, incumbentSide = null, flipMargin = 10 } = {}) {
  if (!callResult && !putResult) return null
  if (!callResult) return { side: 'put', winner: putResult, loser: null, gap: null, isClose: false, flipped: false }
  if (!putResult)  return { side: 'call', winner: callResult, loser: null, gap: null, isClose: false, flipped: false }

  const gap = Math.abs(callResult.score - putResult.score)
  const isClose = gap < minGapToPreferDirection
  let side = callResult.score >= putResult.score ? 'call' : 'put'
  let flipped = false
  let suppressed = false

  // Hysteresis — only applies when we know what's currently displayed for
  // this ticker+timeframe (caller passes incumbentSide from the existing
  // scan_results row, if any). If the fresh winner differs from the
  // incumbent, require it to win by flipMargin points, not just any
  // margin, before actually flipping what gets shown. Both sides are still
  // scored fresh every cycle regardless — this only changes which one is
  // surfaced, so a real, sustained reversal still flips the display once
  // it clears the margin; only noise-level flapping near a scoring cliff
  // gets suppressed.
  if ((incumbentSide === 'call' || incumbentSide === 'put') && side !== incumbentSide) {
    const incumbentResult  = incumbentSide === 'call' ? callResult : putResult
    const challengerResult = incumbentSide === 'call' ? putResult  : callResult
    const trueGap = challengerResult.score - incumbentResult.score
    if (trueGap < flipMargin) {
      side = incumbentSide   // not enough to flip — stick with what's already showing
      suppressed = true
    } else {
      flipped = true         // genuine reversal, large enough to clear the bar
    }
  }

  const winner = side === 'call' ? callResult : putResult
  const loser  = side === 'call' ? putResult  : callResult

  return { side, winner, loser, gap, isClose, flipped, suppressed }
}

// safeIV: Tradier occasionally returns mid_iv as the literal string 'NaN' when
// its IV solver fails to converge (stale/zero/crossed bid-ask, common
// pre-market) — that string is truthy, so a plain '||0' fallback never
// catches it. Also bounds the result below 5.0 (500%): confirmed live, a
// different solver failure mode where mid_iv came back as 48.7 (already a
// percent-like number) instead of the expected decimal (~0.487), which then
// got multiplied by 100 again at display time and showed "IV: 4870%". A real
// IV decimal should never approach 5.0 even for the most extreme/illiquid
// contracts. Lives here (not duplicated separately in scanLogic.js) since
// it directly feeds scoreConviction's IV-band logic above — same reasoning
// as keeping the scoring itself in one place.
function safeIV(o, fallback=0) {
  const a = parseFloat(o?.greeks?.mid_iv)
  if (!isNaN(a) && a>0 && a<5) return a
  const b = parseFloat(o?.implied_volatility)
  if (!isNaN(b) && b>0 && b<5) return b
  return fallback
}

module.exports = { scoreConviction, safeIV, pickBetterSide, TF_WEIGHT_PROFILES }
