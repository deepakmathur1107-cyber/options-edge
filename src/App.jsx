import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import AppNav from './components/AppNav'
import MorningBrief from './components/MorningBrief'
import TweetShare from './components/TweetShare'
import AdminDashboard from './components/AdminDashboard'
import { DARK_THEME, LIGHT_THEME } from './theme'
import { getSessionPhase } from './lib/marketSession'
import { scoreConviction, pickBetterSide } from './lib/convictionScore'

// ─── Safe localStorage helper ─────────────────────────────────────────────────
const ls = (key, fallback='') => {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

// Module-level C = dark theme default (DARK_THEME imported from ./theme).
// Keeps TF_CONFIG, EXIT_RULES, CAT_COLOR colours valid at module scope.
// Inside App(), `const C = isDark ? DARK_THEME : LIGHT_THEME` shadows this for JSX.
const C = DARK_THEME

// ─── Helpers ──────────────────────────────────────────────────────────────────
const autoStep = p => p<25?.5:p<50?1:p<100?2:p<250?5:p<500?10:p<1000?20:50
const fmtP   = n => n==null?'—':'$'+parseFloat(n).toFixed(2)
const fmtPct = n => n==null?'—':(parseFloat(n)*100).toFixed(1)+'%'
const safe   = v => v==null?'—':typeof v==='object'?JSON.stringify(v):String(v)

// ─── Module-level constants ───────────────────────────────────────────────────
const PRESET_SYMS = ['SPY','QQQ','IWM','AAPL','TSLA','NVDA','AMZN','META']

// ─── ET-aware time helpers ───────────────────────────────────────────────────
// Always use Eastern Time for market-hour checks — users may be in any timezone
function getETHour() {
  const now = new Date()
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false })
  const [h, m] = etStr.split(':').map(Number)
  return h + m / 60
}
function isMarketOpen() {
  const h = getETHour()
  const now = new Date()
  const dayET = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
  if (['Sat', 'Sun'].includes(dayET)) return false
  return h >= 9.5 && h < 16
}
function isOpeningWindow() { return getETHour() < 10.0 }  // first 30 min ET
function isPreMarket() {
  const h = getETHour()
  const now = new Date()
  const dayET = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
  if (['Sat', 'Sun'].includes(dayET)) return false
  return h >= 4.0 && h < 9.5
}

const TF_CONFIG = {
  'Quick (5–14 DTE)': {
    minDTE:5,   maxDTE:14,  strikePct:1.02, profitTarget:0.50, stopLoss:0.50,
    label:'Quick Play', badge:'⚡', color:C.green,
    desc:'5–14 DTE · Fast momentum plays · 50% profit target',
  },
  'Swing (21–45 DTE)': {
    minDTE:21,  maxDTE:45,  strikePct:1.02, profitTarget:0.80, stopLoss:0.50,
    label:'Swing Trade', badge:'📈', color:C.blue,
    desc:'21–45 DTE · Directional swing · 80% profit target',
  },
  'LEAP (90–180 DTE)': {
    minDTE:90,  maxDTE:180, strikePct:1.05, profitTarget:1.00, stopLoss:0.40,
    label:'LEAP Option', badge:'🏔️', color:C.orange,
    desc:'90–180 DTE · Trend plays · 100% profit target',
  },
  'Deep LEAP (180–365 DTE)': {
    minDTE:180, maxDTE:365, strikePct:1.08, profitTarget:1.50, stopLoss:0.35,
    label:'Deep LEAP', badge:'🚀', color:C.red,
    desc:'180–365 DTE · Long conviction · 150% profit target',
  },
}

// Pick the best expiry date within a DTE window.
// Falls back to the closest available if no exact match in range.
const pickExpiry = (dates, minDTE, maxDTE) => {
  const now = new Date(); now.setHours(0,0,0,0)
  const withDTE = dates.map(d => {
    const exp = new Date(d+'T12:00:00')
    const dte = Math.round((exp-now)/(1000*60*60*24))
    return {date:d, dte}
  }).filter(x=>x.dte>0)
  // Ideal: first expiry inside the DTE window
  const inRange = withDTE.filter(x=>x.dte>=minDTE && x.dte<=maxDTE)
  if (inRange.length) return inRange[0].date
  // Fallback: closest expiry to the midpoint of the window
  const mid=(minDTE+maxDTE)/2
  return withDTE.reduce((best,x)=>Math.abs(x.dte-mid)<Math.abs(best.dte-mid)?x:best, withDTE[0]).date
}

// ─── Structure Intelligence ──────────────────────────────────────────────────
// Analyses IV level, momentum, and directional strength to recommend the
// optimal options structure for each setup. Zero API calls — pure logic.
//
// Decision matrix:
//   IV > 55%  + direction   → Credit Spread  (sell elevated premium)
//   IV > 55%  + no dir      → Iron Condor    (range-bound, collect both sides)
//   IV 28-55% + direction   → Debit Spread   (45% cheaper than naked)
//   IV 28-55% + no dir      → Butterfly      (pin play, cheapest structure)
//   IV < 28%  + direction   → Naked Option   (premium cheap, max leverage)
//   IV < 28%  + no dir      → Strangle       (cheap to buy both sides)

// ─── Structure + GEX helpers ─────────────────────────────────────────────────

// spreadWidth: distance between spread legs, scaled to stock price
// Ensures realistic bid/ask spreads and meaningful risk/reward
const spreadWidth = p => p>=3000?100 : p>=500?25 : p>=200?10 : p>=50?5 : 2.5

// findLeg: contract in arr closest to target strike
const findLeg = (arr, tgt) =>
  arr.length ? arr.reduce((a,b)=>Math.abs(b.strike-tgt)<Math.abs(a.strike-tgt)?b:a) : null

// safeIV: Tradier occasionally returns mid_iv as the literal string 'NaN' when its
// IV solver fails to converge (stale/zero/crossed bid-ask, common pre-market). That
// string is truthy, so a plain '||0' fallback never catches it — must validate the
// parsed number explicitly. fallback defaults to 0 (display fields) but approxGEX
// passes 0.3 so a broken IV doesn't zero out its gamma-proxy math.
//
// FIX: also bounds the result below 5.0 (500%) — confirmed live, a different
// solver failure mode than the NaN-string case: an NFLX put returned mid_iv
// as 48.7 (already a percent-like number) instead of the expected decimal
// (~0.487), which then got multiplied by 100 again at display time and
// showed "IV: 4870%". A real IV decimal should never approach 5.0 even for
// the most extreme/illiquid contracts, so treat anything at or above that as
// a solver glitch and fall through to the next source / fallback instead.
const safeIV = (o, fallback=0) => {
  const a = parseFloat(o?.greeks?.mid_iv)
  if (!isNaN(a) && a>0 && a<5) return a
  const b = parseFloat(o?.implied_volatility)
  if (!isNaN(b) && b>0 && b<5) return b
  return fallback
}

// safeChgPct: Tradier's change_percentage (and change/last) only update from the
// regular-session tape — they stay frozen at 0 vs prevclose before 9:30 AM ET no
// matter how far the stock has actually moved in pre-market trading. NBBO bid/ask,
// unlike last/change, does update pre-market (wider spreads, but live).
//
// FIX: was only checked on EXACT-zero readings during the pre-market window —
// confirmed live to miss a real case: a TSLA scan ~30 min after the regular
// open showed 82% conviction on a $400C call after TSLA had already gapped
// from ~$394 to ~$413 (+4.8%, squarely inside the 2–5% chasing band that
// should have capped the score at 42%). change_percentage was non-zero but
// still wrong for the chasing check — trusted at face value since the old
// logic only ever double-checked an exact 0, and this wasn't even pre-market.
//
// Now: always cross-check the reported value against a bid/ask-derived
// estimate when bid/ask is available, and use whichever magnitude is LARGER
// for anything chasing-related — under-detecting a real gap-up costs real
// money buying into an already-priced-in move; over-flagging just skips a
// trade. Mirrors the matching fix in api/_lib/scanLogic.js — keep both in
// sync, same as the original comment here already asked for.
// Returns { pct, estimated } so callers can flag the value as derived rather
// than presenting it with regular-session confidence.
const safeChgPct = (q) => {
  const reported = parseFloat(q?.change_percentage)
  const validReported = !isNaN(reported) ? reported : 0

  const bid  = parseFloat(q?.bid)
  const ask  = parseFloat(q?.ask)
  const prev = parseFloat(q?.prevclose)
  const hasBidAsk = !isNaN(bid) && !isNaN(ask) && bid>0 && ask>0 && !isNaN(prev) && prev>0

  if (!hasBidAsk) return { pct: validReported, estimated: false }

  const mid = (bid+ask)/2
  const bidAskPct = ((mid-prev)/prev)*100

  if (validReported === 0) return { pct: bidAskPct, estimated: true }

  const diverges = Math.abs(Math.abs(reported) - Math.abs(bidAskPct)) > 1.0
  if (!diverges) return { pct: validReported, estimated: false }
  const useBidAsk = Math.abs(bidAskPct) > Math.abs(validReported)
  return { pct: useBidAsk ? bidAskPct : validReported, estimated: useBidAsk }
}

// approxGEX: proxy Gamma Exposure from chain data.
// Real GEX = gamma × OI × 100 × price². We don't have gamma directly from
// Tradier greeks names, but mid_iv + delta let us approximate it via
// Black-Scholes approximation: gamma ≈ delta(1-delta)/(price × iv × √(dte/365))
// Since dte isn't per-contract, we use a constant 30-day proxy. The relative
// ranking across strikes is what matters, not the absolute value.
const approxGEX = (o, price) => {
  const oi    = parseFloat(o.open_interest||0)
  // Tradier occasionally returns mid_iv as the literal string 'NaN' when its IV
  // solver fails to converge (stale/wide/zero bid-ask, common pre-market). A
  // non-empty string is truthy, so '||0.3' alone won't catch it — validate explicitly.
  const ivRaw  = parseFloat(o.greeks?.mid_iv)
  const ivRaw2 = parseFloat(o.implied_volatility)
  const iv     = (!isNaN(ivRaw)&&ivRaw>0) ? ivRaw : (!isNaN(ivRaw2)&&ivRaw2>0) ? ivRaw2 : 0.3
  const delta = Math.abs(parseFloat(o.greeks?.delta||0.5))
  if (!oi || iv===0) return 0
  // gamma proxy: bell-shaped, peaks at delta=0.5
  const gammaPx = delta*(1-delta) / (price * iv * Math.sqrt(30/365))
  // sign here is just optType (call=+1, put=-1) times the magnitude above —
  // NOT a measure of dealer positioning. A true dealer-long/short-gamma read
  // would require aggregating both calls AND puts at a strike with knowledge
  // of which side market makers are actually short, which this function does
  // not have. Comment corrected — see gexNote below, which used to claim
  // "Dealers long/short gamma" based on this same sign and has been reworded
  // to describe what's actually known (gamma-weighted OI concentration).
  const sign = o.option_type==='call' ? 1 : -1
  return sign * gammaPx * oi * 100
}

// gexMagnitudeNorm: 0-1 normalized |gex| for one contract relative to the
// actual range of |gex| values across the side it's on — mirrors the fix in
// api/_lib/scanLogic.js (the server-side scanner's copy of this same logic).
// An earlier version of both copies normalized against allOI*0.01+1, which
// saturates Math.min(...,1) to 1.0 for nearly every realistically-selected
// contract once real-world OI is in the thousands (confirmed by direct
// calculation: raw gex routinely 100-300x the old denominator). Fixed by
// normalizing against max(|gex|) actually observed on that side instead.
const gexMagnitudeNorm = (o, price, allGexAbsMax) => {
  if (!allGexAbsMax || allGexAbsMax <= 0) return 0
  const gex = Math.abs(approxGEX(o, price))
  return Math.min(gex / allGexAbsMax, 1)
}

// scoreStrike: composite score for a single option contract
// Weights: OI 35% | Volume 30% | Delta quality 25% | GEX 10%
// Higher score = better liquidity + positioning for profitable trades
const scoreStrike = (o, price, allOI, allVol) => {
  if (!o) return 0
  const oi      = parseFloat(o.open_interest||0)
  const vol     = parseFloat(o.volume||0)
  const delta   = Math.abs(parseFloat(o.greeks?.delta||0))
  const bid     = parseFloat(o.bid||0)
  const ask     = parseFloat(o.ask||0)
  const mid     = (bid+ask)/2

  if (mid === 0 || bid === 0) return 0           // no liquidity = skip

  // Normalise OI and volume (0–1) against max in chain
  const oiScore  = allOI  > 0 ? oi  / allOI  : 0
  const volScore = allVol > 0 ? vol / allVol  : 0

  // Delta quality: reward 0.30–0.55 range (enough premium, not too deep ITM)
  const dScore = delta>=0.30 && delta<=0.55 ? 1.0
               : delta>=0.20 && delta<=0.65 ? 0.6
               : delta>=0.10                ? 0.2 : 0

  // Bid-ask spread penalty: wide spread = less liquid
  const spread = ask > 0 ? (ask-bid)/ask : 1
  const liqPen = 1 - Math.min(spread, 0.5)*0.6   // max 30% penalty

  // GEX alignment bonus (high GEX absolute = important price level)
  const gex     = Math.abs(approxGEX(o, price))
  const gexNorm = Math.min(gex / (allOI * 0.01 + 1), 1)

  return (oiScore*0.35 + volScore*0.30 + dScore*0.25 + gexNorm*0.10) * liqPen
}

// findBestStrike: score the full side of the chain and return the highest-scoring
// contract within ±2 strikes of the target DTE-adjusted strike.
// Falls back to closest-to-target if no scored results found.
const findBestStrike = (side, tgtStrike, price) => {
  if (!side.length) return null
  const allOI  = Math.max(...side.map(o=>parseFloat(o.open_interest||0)), 1)
  const allVol = Math.max(...side.map(o=>parseFloat(o.volume||0)), 1)

  // Candidates: strikes within ±3 steps of tgtStrike that have liquidity
  const step   = autoStep(price)
  const window = step * 3
  const cands  = side.filter(o =>
    Math.abs(o.strike - tgtStrike) <= window &&
    parseFloat(o.bid||0) > 0
  )

  if (cands.length === 0) return findLeg(side, tgtStrike)  // fallback

  // Score each candidate
  const scored = cands.map(o => ({ o, s: scoreStrike(o, price, allOI, allVol) }))
  scored.sort((a,b)=>b.s-a.s)
  return scored[0].o
}

// findGEXWall: finds the nearest high-OI strike above/below price (resistance/support)
// Used for the SHORT leg of spreads — placing it at a natural wall improves success rate
const findGEXWall = (side, price, direction) => {
  // direction: 'above' for calls (resistance), 'below' for puts (support)
  const filtered = direction==='above'
    ? side.filter(o=>o.strike>price).sort((a,b)=>a.strike-b.strike)
    : side.filter(o=>o.strike<price).sort((a,b)=>b.strike-a.strike)
  if (!filtered.length) return null
  const maxOI = Math.max(...filtered.slice(0,8).map(o=>parseFloat(o.open_interest||0)),1)
  const scored = filtered.slice(0,8).map(o=>({
    o, score: parseFloat(o.open_interest||0)/maxOI * (parseFloat(o.volume||0)>0?1.2:1)
  }))
  scored.sort((a,b)=>b.score-a.score)
  return scored[0]?.o || filtered[0]
}

// ─── buildNakedResult ─────────────────────────────────────────────────────────
// Finds the highest-conviction single strike using GEX + OI + Volume scoring.
// The target strike from tfCfg is the starting point; findBestStrike picks the
// highest-scoring contract within ±3 steps of that target.
const buildNakedResult = (chain, price, step, optType, tfCfg) => {
  const suf  = optType==='call' ? 'C' : 'P'
  const pct  = optType==='call' ? tfCfg.strikePct : (2-tfCfg.strikePct)
  let tgt = Math.round(price*pct/step)*step
  if (optType === 'put'  && tgt >= price) tgt = Math.round((price - step) / step) * step
  if (optType === 'call' && tgt <= price) tgt = Math.round((price + step) / step) * step
  const side = chain.filter(o=>o.option_type===optType)

  // Use GEX+OI+Volume scoring to find the best strike
  const otmSide = optType === 'put'
    ? side.filter(o => o.strike < price)
    : side.filter(o => o.strike > price)
  const best = findBestStrike(otmSide.length ? otmSide : side, tgt, price)
  if (!best) return null
  const b=parseFloat(best.bid||0), a=parseFloat(best.ask||0), m=(b+a)/2
  if (m===0) return null
  const f2 = v => Math.max(0,v).toFixed(2)

  // Strike quality signals for display
  const allOI  = Math.max(...side.map(o=>parseFloat(o.open_interest||0)),1)
  const allVol = Math.max(...side.map(o=>parseFloat(o.volume||0)),1)
  const sc     = scoreStrike(best, price, allOI, allVol)
  const gex    = approxGEX(best, price)
  // allGexAbsMax computed across THIS side of the chain — see gexMagnitudeNorm
  // comment above for why this replaced the old allOI-scaled denominator.
  const allGexAbsMax = Math.max(...side.map(o=>Math.abs(approxGEX(o, price))), 1)
  const strikeQuality = sc>=0.60?'⭐ HIGH CONVICTION':sc>=0.35?'MODERATE':'LOW — check liquidity'

  return {
    strikeStr:     `$${best.strike}${suf}`,
    bid:b, ask:a, mid:m,
    entry:         `$${f2(m*0.95)} – $${f2(m*1.05)}  (mid $${f2(m)})`,
    target:        `$${f2(m*(1+tfCfg.profitTarget))}  (+${(tfCfg.profitTarget*100).toFixed(0)}%)`,
    stop:          `$${f2(m*(1-tfCfg.stopLoss))}  (−${(tfCfg.stopLoss*100).toFixed(0)}%)`,
    structureType: optType==='call' ? 'Long Call' : 'Long Put',
    legs:          null,
    iv:            safeIV(best),
    delta:         best.greeks?.delta||null,
    theta:         best.greeks?.theta||null,
    volume:        best.volume||0,
    oi:            best.open_interest||0,
    primaryStrike: best.strike,
    strikeScore:   sc,
    strikeQuality,
    gexSign:       gex>=0?'positive':'negative',
    gexMagnitude01: gexMagnitudeNorm(best, price, allGexAbsMax),
    // Reworded — previous text ("Dealers long/short gamma...pinning/breakout
    // zone") claimed a directional dealer-positioning read this calculation
    // can't actually support (sign here is just call-vs-put, not net dealer
    // exposure; see approxGEX's corrected comment above). What this DOES
    // legitimately tell you: how much open-interest-weighted gamma is
    // concentrated at this specific strike relative to the rest of the chain
    // — a real signal about strike significance, just not a directional one.
    gexNote:       gex!==0
      ? `$${best.strike} carries meaningful gamma-weighted open interest — a strike other traders have concentrated into, not a thin/orphan level`
      : `Low gamma-weighted open interest at $${best.strike} — not a strike with much concentrated positioning`,
  }
}

// ─── buildSpreadResult ────────────────────────────────────────────────────────
// Only called when user explicitly picks a multi-leg structure from the dropdown.
// ALL prices from real chain bid/ask — zero percentage guessing.
const buildSpreadResult = (chain, price, step, scanType, tfCfg) => {
  const calls = chain.filter(o=>o.option_type==='call').sort((a,b)=>a.strike-b.strike)
  const puts  = chain.filter(o=>o.option_type==='put' ).sort((a,b)=>a.strike-b.strike)
  const w     = spreadWidth(price)
  const atm   = Math.round(price/step)*step
  const f2    = v => Math.max(0,v).toFixed(2)
  const B     = o => Math.max(0,parseFloat(o?.bid||0))
  const A     = o => Math.max(0,parseFloat(o?.ask||0))
  const M     = o => (B(o)+A(o))/2

  if (scanType==='Call Spread') {
    const longTgt  = Math.round(price*tfCfg.strikePct/step)*step
    // Long leg: GEX+OI+Volume best strike near target
    const longLeg  = findBestStrike(calls, longTgt, price)
    if (!longLeg) return null
    // Short leg: nearest GEX wall above price (high-OI resistance) within spread width
    const gexWall  = findGEXWall(calls, price, 'above')
    const shortTgt = gexWall && Math.abs(gexWall.strike-longLeg.strike)<=w*2 && gexWall.strike>longLeg.strike
                   ? gexWall.strike : longLeg.strike+w
    const shortLeg = findLeg(calls, shortTgt)
    if (!shortLeg||shortLeg.strike===longLeg.strike||B(shortLeg)===0) return null
    const nd = Math.max(0.01, A(longLeg)-B(shortLeg))
    const sw = Math.abs(shortLeg.strike-longLeg.strike)
    const mp = Math.max(0, sw-nd)
    return {
      strikeStr:`$${longLeg.strike}C / $${shortLeg.strike}C`,
      bid:nd, ask:nd, mid:nd,
      entry:  `$${f2(nd)} net debit  ($${(nd*100).toFixed(0)}/contract)`,
      target: `$${f2(nd+mp*0.75)} spread value  (75% of max profit $${(mp*100).toFixed(0)}/contract)`,
      stop:   `$${f2(nd*0.50)}  (−50% of debit paid)`,
      structureType:'Bull Call Spread',
      legs:[
        `BUY  $${longLeg.strike}C    bid $${f2(B(longLeg))} / ask $${f2(A(longLeg))} / mid $${f2(M(longLeg))}`,
        `SELL $${shortLeg.strike}C   bid $${f2(B(shortLeg))} / ask $${f2(A(shortLeg))} / mid $${f2(M(shortLeg))}`,
        `NET DEBIT $${f2(nd)}  ·  max profit $${(mp*100).toFixed(0)}/contract  ·  max loss $${(nd*100).toFixed(0)}/contract`,
      ],
      iv:safeIV(longLeg), delta:longLeg.greeks?.delta||null,
      theta:longLeg.greeks?.theta||null,
      volume:longLeg.volume||0, oi:longLeg.open_interest||0, primaryStrike:longLeg.strike,
    }
  }

  if (scanType==='Put Spread') {
    const longTgt  = Math.round(price*(2-tfCfg.strikePct)/step)*step
    // Long leg: GEX+OI+Volume best strike near target
    const longLeg  = findBestStrike(puts, longTgt, price)
    if (!longLeg) return null
    // Short leg: nearest GEX wall below price (high-OI support) within spread width
    const gexWall  = findGEXWall(puts, price, 'below')
    const shortTgt = gexWall && Math.abs(gexWall.strike-longLeg.strike)<=w*2 && gexWall.strike<longLeg.strike
                   ? gexWall.strike : longLeg.strike-w
    const shortLeg = findLeg(puts, shortTgt)
    if (!shortLeg||shortLeg.strike===longLeg.strike||B(shortLeg)===0) return null
    const nd = Math.max(0.01, A(longLeg)-B(shortLeg))
    const sw = Math.abs(longLeg.strike-shortLeg.strike)
    const mp = Math.max(0, sw-nd)
    return {
      strikeStr:`$${longLeg.strike}P / $${shortLeg.strike}P`,
      bid:nd, ask:nd, mid:nd,
      entry:  `$${f2(nd)} net debit  ($${(nd*100).toFixed(0)}/contract)`,
      target: `$${f2(nd+mp*0.75)} spread value  (75% of max profit $${(mp*100).toFixed(0)}/contract)`,
      stop:   `$${f2(nd*0.50)}  (−50% of debit paid)`,
      structureType:'Bear Put Spread',
      legs:[
        `BUY  $${longLeg.strike}P    bid $${f2(B(longLeg))} / ask $${f2(A(longLeg))} / mid $${f2(M(longLeg))}`,
        `SELL $${shortLeg.strike}P   bid $${f2(B(shortLeg))} / ask $${f2(A(shortLeg))} / mid $${f2(M(shortLeg))}`,
        `NET DEBIT $${f2(nd)}  ·  max profit $${(mp*100).toFixed(0)}/contract  ·  max loss $${(nd*100).toFixed(0)}/contract`,
      ],
      iv:safeIV(longLeg), delta:longLeg.greeks?.delta||null,
      theta:longLeg.greeks?.theta||null,
      volume:longLeg.volume||0, oi:longLeg.open_interest||0, primaryStrike:longLeg.strike,
    }
  }

  if (scanType==='Iron Condor') {
    const ps=findLeg(puts, Math.round(price*0.97/step)*step)
    const pl=findLeg(puts, Math.round(price*0.94/step)*step)
    const cs=findLeg(calls,Math.round(price*1.03/step)*step)
    const cl=findLeg(calls,Math.round(price*1.06/step)*step)
    if (!ps||!pl||!cs||!cl) return null
    const pc=Math.max(0,B(ps)-A(pl)), cc=Math.max(0,B(cs)-A(cl)), tc=pc+cc
    if (tc<=0) return null
    return {
      strikeStr:`$${ps.strike}P-$${pl.strike}P / $${cs.strike}C-$${cl.strike}C`,
      bid:tc, ask:tc, mid:tc,
      entry:  `$${f2(tc)} total credit  ($${(tc*100).toFixed(0)}/contract)`,
      target: `Close at 50% profit — buy back for $${f2(tc*0.50)}`,
      stop:   `Exit if either short strike ($${ps.strike}P or $${cs.strike}C) is breached`,
      structureType:'Iron Condor',
      legs:[
        `SELL $${ps.strike}P   bid $${f2(B(ps))} / ask $${f2(A(ps))}`,
        `BUY  $${pl.strike}P   bid $${f2(B(pl))} / ask $${f2(A(pl))}`,
        `SELL $${cs.strike}C   bid $${f2(B(cs))} / ask $${f2(A(cs))}`,
        `BUY  $${cl.strike}C   bid $${f2(B(cl))} / ask $${f2(A(cl))}`,
        `TOTAL CREDIT $${f2(tc)}  ($${(tc*100).toFixed(0)}/contract)  ·  max loss = spread width − credit`,
      ],
      iv:safeIV(cs), delta:cs.greeks?.delta||null,
      theta:null, volume:cs.volume||0, oi:cs.open_interest||0, primaryStrike:cs.strike,
    }
  }

  if (scanType==='Butterfly') {
    const mid_=findLeg(calls,atm)
    if (!mid_) return null
    const lo=findLeg(calls,atm-w), hi=findLeg(calls,atm+w)
    if (!lo||!hi||lo.strike===mid_.strike||hi.strike===mid_.strike) return null
    const nd=Math.max(0.01, A(lo)-2*B(mid_)+A(hi))
    const mp=Math.max(0,w-nd)
    return {
      strikeStr:`$${lo.strike}/$${mid_.strike}/$${hi.strike}C`,
      bid:nd, ask:nd, mid:nd,
      entry:  `$${f2(nd)} net debit  ($${(nd*100).toFixed(0)}/contract)`,
      target: `$${f2(nd+mp*0.60)} spread value  (60% of max profit $${(mp*100).toFixed(0)}/contract)`,
      stop:   `$${f2(nd*0.50)}  (−50% of debit)`,
      structureType:'Butterfly',
      legs:[
        `BUY  1× $${lo.strike}C    bid $${f2(B(lo))} / ask $${f2(A(lo))}`,
        `SELL 2× $${mid_.strike}C  bid $${f2(B(mid_))} / ask $${f2(A(mid_))}`,
        `BUY  1× $${hi.strike}C    bid $${f2(B(hi))} / ask $${f2(A(hi))}`,
        `NET DEBIT $${f2(nd)}  ·  max profit $${(mp*100).toFixed(0)}/contract if stock pins $${mid_.strike} at expiry`,
      ],
      iv:safeIV(mid_), delta:mid_.greeks?.delta||null,
      theta:mid_.greeks?.theta||null,
      volume:mid_.volume||0, oi:mid_.open_interest||0, primaryStrike:mid_.strike,
    }
  }

  if (scanType==='Strangle') {
    const cLeg=findLeg(calls,Math.round(price*1.02/step)*step)
    const pLeg=findLeg(puts, Math.round(price*0.98/step)*step)
    if (!cLeg||!pLeg||A(cLeg)===0||A(pLeg)===0) return null
    const td=A(cLeg)+A(pLeg)
    return {
      strikeStr:`$${pLeg.strike}P / $${cLeg.strike}C`,
      bid:td, ask:td, mid:td,
      entry:  `$${f2(td)} total debit  ($${(td*100).toFixed(0)}/contract)`,
      target: `$${f2(td*2.0)}  (+100% on combined debit)`,
      stop:   `$${f2(td*0.50)}  (−50% of total debit)`,
      structureType:'Long Strangle',
      legs:[
        `BUY $${pLeg.strike}P   bid $${f2(B(pLeg))} / ask $${f2(A(pLeg))} / mid $${f2(M(pLeg))}`,
        `BUY $${cLeg.strike}C   bid $${f2(B(cLeg))} / ask $${f2(A(cLeg))} / mid $${f2(M(cLeg))}`,
        `TOTAL DEBIT $${f2(td)}  ($${(td*100).toFixed(0)}/contract)`,
      ],
      iv:safeIV(cLeg), delta:null,
      theta:cLeg.greeks?.theta||null,
      volume:cLeg.volume||0, oi:cLeg.open_interest||0, primaryStrike:cLeg.strike,
    }
  }

  return null  // unknown scanType
}

const FUT_SYMBOLS = {
  // Primary is the Tradier-reliable symbol. SPX/NDX are the real index levels (≈ /ES /NQ)
  ES:  { name:'SPX — S&P 500 Index',     primary:'SPX',  fallback:'$SPX.X', chain:'SPX',  display:'SPX' },
  NQ:  { name:'NDX — Nasdaq 100 Index',  primary:'NDX',  fallback:'$NDX.X', chain:'NDX',  display:'NDX' },
  YM:  { name:'DJX — Dow Jones Index',   primary:'DJX',  fallback:'$DJI',   chain:'DJX',  display:'DJX' },
  RTY: { name:'RUT — Russell 2000',      primary:'RUT',  fallback:'$RUT.X', chain:'RUT',  display:'RUT' },
  CL:  { name:'/CL — Crude Oil (USO)',   primary:'USO',  fallback:'USO',    chain:'USO',  display:'USO' },
  GC:  { name:'/GC — Gold (GLD)',        primary:'GLD',  fallback:'GLD',    chain:'GLD',  display:'GLD' },
}

// Full S&P 500 constituent list
const SP500 = [
  'AAPL','MSFT','NVDA','AVGO','META','ORCL','CRM','AMD','INTC','QCOM',
  'TXN','AMAT','LRCX','KLAC','MCHP','CDNS','SNPS','ADI','MRVL','FTNT',
  'PANW','CRWD','DDOG','SNOW','MDB','ZS','NET','OKTA','TWLO','DOCN',
  'ADBE','NOW','WDAY','ANSS','PTC','TYL','EPAM','CTSH','ACN','IBM',
  'HPE','HPQ','STX','WDC','NTAP','PSTG','DELL','SMCI',
  'GOOGL','GOOG','NFLX','DIS','CMCSA','T','VZ','CHTR','TMUS',
  'PARA','WBD','FOXA','FOX','OMC','IPG','TTWO','EA','RBLX',
  'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TJX','BKNG','CMG',
  'YUM','DG','DLTR','ROST','BBY','ETSY','EBAY','ABNB','LYFT','UBER',
  'F','GM','RIVN','LCID','APTV','MGA','BWA',
  'WMT','COST','PG','KO','PEP','PM','MO','MDLZ','KHC',
  'GIS','K','CPB','SJM','HRL','CAG','MKC','CHD','CLX','KMB',
  'JPM','BAC','WFC','GS','MS','C','BLK','SCHW','AXP','V','MA',
  'COF','USB','TFC','PNC','FITB','HBAN','KEY','RF','CFG','MTB',
  'STT','BK','NTRS','ICE','CME','CBOE','NDAQ','MCO','SPGI','FDS',
  'AFL','MET','PRU','AIG','TRV','ALL','CB','MMC','WTW','AON',
  'LLY','JNJ','UNH','ABBV','MRK','PFE','ABT','TMO','DHR','BMY',
  'AMGN','GILD','REGN','VRTX','BIIB','MRNA','BNTX','ILMN','IQV',
  'CVS','CI','HUM','CNC','MOH','ELV','DGX','LH','HOLX','BAX',
  'BSX','EW','SYK','MDT','BDX','ZBH','STE','HSIC','RMD','IDXX',
  'CAT','BA','HON','GE','LMT','RTX','NOC','GD','HII',
  'UPS','FDX','DAL','UAL','AAL','LUV','ALK','EXPD','XPO','JBHT',
  'DE','EMR','ETN','ROK','PH','ITW','DOV','AME','NDSN','GWW',
  'URI','WAB','TT','CARR','OTIS','JCI','GNRC',
  'XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','HAL',
  'DVN','FANG','PXD','APA','HES','MRO','OKE','KMI','WMB','ET',
  'LIN','APD','SHW','ECL','PPG','NEM','GOLD','FCX','NUE','STLD',
  'RS','CF','MOS','ALB','EMN','CE','IFF','FMC','RPM','SEE',
  'AMT','PLD','CCI','EQIX','DLR','PSA','EQR','AVB','VTR','WELL',
  'ARE','BXP','SLG','KIM','REG','FRT','SPG','MAC','SKT','O',
  'NEE','DUK','SO','AEP','EXC','SRE','PCG','ED','EIX','XEL',
  'WEC','ETR','PPL','CMS','LNT','PNW','OGE','EVRG','NI',
  'SPY','QQQ','IWM','DIA','GLD','SLV','USO','TLT','HYG','LQD',
  'XLF','XLE','XLK','XLV','XLI','XLU','XLB','XLRE','XLP','XLY',
  'COIN','MSTR','PLTR','SOFI','HOOD','UPST','AFRM',
  'CVNA','IONQ','ARRY','ENPH','SEDG','RUN','FSLR','NOVA',
]

const CHECKLIST = [
  {id:'trend',cat:'TA',   l:'Trend Direction Confirmed', d:'20/50/200 EMA alignment checked'},
  {id:'rsi',  cat:'TA',   l:'RSI Not Extreme',           d:'RSI between 30–70 or confirmed reversal'},
  {id:'vol',  cat:'TA',   l:'Volume Above Average',      d:'At least 1.2x the 20-day avg — NOT first 30 min'},
  {id:'macd', cat:'TA',   l:'MACD Confirmation',         d:'Crossover in trade direction'},
  {id:'lvl',  cat:'TA',   l:'Key Level Identified',      d:'Clear S/R, trendline, or breakout'},
  {id:'notch',cat:'TA',   l:'Stock NOT already moved >2% today', d:'Chasing a gap = paying inflated premium. Wait for a pullback or skip.'},
  {id:'flow', cat:'Flow', l:'Options Flow Checked',      d:'Unusual sweeps align with thesis'},
  {id:'oi',   cat:'Flow', l:'Open Interest at Strikes',  d:'High OI at your strikes = magnet zones'},
  {id:'iv',   cat:'Flow', l:'IV Rank Assessed',          d:'Buy low IV (<40%), sell high IV (>55%). MSTR at 66% = sell, not buy.'},
  {id:'voloc',cat:'Flow', l:'Volume has directional context', d:'High vol alone means nothing — sweeps on ASK = buying, BID = selling. Confirm directionality.'},
  {id:'cat',  cat:'News', l:'Catalyst Identified',       d:'Know the SPECIFIC WHY — earnings date, product launch, macro event, technical breakout'},
  {id:'time', cat:'News', l:'Catalyst Timing Clear',     d:'Event date vs expiry date checked. No catalyst = no long option.'},
  {id:'beven',cat:'News', l:'Break-even is realistic',   d:'Stock must reach strike + premium by expiry. Is that move historically probable?'},
  {id:'size', cat:'Risk', l:'Position Sized Correctly',  d:'Max 2–5% of account per trade'},
  {id:'stop', cat:'Risk', l:'Stop Loss Defined',         d:'50% loss on debit, 2x on credit'},
  {id:'tgt',  cat:'Risk', l:'Profit Target Set',         d:'25–50% quick, 50–100% swings'},
  {id:'plan', cat:'Risk', l:'Exit Scenario Planned',     d:'What if it goes against you?'},
  {id:'time2',cat:'Risk', l:'If entering at open: size is reduced', d:'First 30 min is volatile — spreads are wider and volume signals are unreliable. Still tradeable if conviction is high, but use a limit at mid and size 50% of normal.'},
]

const CAT_COLOR = { TA:C.green, Flow:C.blue, News:C.orange, Risk:C.red }

const EXIT_RULES = [
  { type:'Quick Plays (0–14 DTE)', color:C.green, rules:[
    {tr:'Profit Target', a:'Close at 25–40% gain on premium'},
    {tr:'Stop Loss',     a:'Exit at 50% loss — no exceptions'},
    {tr:'Time Stop',     a:'Exit EOD if no movement in 2 sessions'},
    {tr:'Post-Catalyst', a:'Close immediately after news event'},
  ]},
  { type:'Swing Trades (21–45 DTE)', color:C.blue, rules:[
    {tr:'Profit Target', a:'Take 50% at first target, trail the rest'},
    {tr:'Stop Loss',     a:'50% loss on debit, 2x credit for shorts'},
    {tr:'Time Decay',    a:'Close all longs at 21 DTE'},
    {tr:'Level Break',   a:'Key level violated? Close immediately'},
  ]},
  { type:'Iron Condors / Strangles', color:C.orange, rules:[
    {tr:'Profit Target', a:'Close at 50% of max profit'},
    {tr:'Time Exit',     a:'Always close at 21 DTE'},
    {tr:'Strike Breach', a:'Adjust or close if price hits short strike'},
    {tr:'IV Spike',      a:'IV doubles? Close and reassess'},
  ]},
]

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, options, rows, type='text', C: lC }) {
  const themeC = lC || C
  const fSt = {
    width:'100%', background:themeC.inputBg, border:`1px solid ${themeC.border}`,
    borderRadius:4, color:themeC.text, padding:'9px 12px',
    fontSize:12, fontFamily:'inherit', transition:'border-color .15s',
  }
  return (
    <div>
      <div style={{fontSize:11,fontWeight:600,color:themeC.dim,letterSpacing:0.5,marginBottom:4,textTransform:'uppercase',fontFamily:"'Inter',sans-serif"}}>{label}</div>
      {options
        ? <select value={value} onChange={e=>onChange(e.target.value)} style={fSt}>
            {options.map(o=><option key={o.v||o} value={o.v||o}>{o.l||o}</option>)}
          </select>
        : rows
          ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{...fSt,resize:'vertical'}}/>
          : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={fSt}/>
      }
    </div>
  )
}

function Card({ color, children, style={}, C: lC }) {
  const themeC = lC || C
  return (
    <div style={{background:themeC.card,border:`1px solid ${color||themeC.border}`,borderRadius:6,padding:14,...style}}>
      {children}
    </div>
  )
}

function Lbl({ children, color, C: lC }) {
  const themeC = lC || C
  return <div style={{fontSize:11,fontWeight:600,color:color??themeC.dim,letterSpacing:0.5,marginBottom:6,textTransform:'uppercase',fontFamily:"'Inter',sans-serif"}}>{children}</div>
}

function Pill({ label, active, color, onClick, C: lC }) {
  const themeC = lC || C
  const pillColor = color ?? themeC.green
  return (
    <button onClick={onClick} style={{
      padding:'7px 14px',borderRadius:4,fontSize:11,letterSpacing:.8,cursor:'pointer',
      border:`1px solid ${active?pillColor:themeC.border}`,color:active?pillColor:themeC.dim,
      background:active?`${pillColor}18`:'transparent',
    }}>{label}</button>
  )
}

// ─── P&L Sparkline ────────────────────────────────────────────────────────────
function PnLChart({ trades, C: lC }) {
  const themeC = lC || C
  const closed = [...trades].filter(t=>t.status!=='Open').reverse()
  if (closed.length < 2) return (
    <div style={{textAlign:'center',padding:'20px 0',fontSize:11,color:themeC.dim,border:`1px dashed ${themeC.border}`,borderRadius:6}}>
      Log 2+ closed trades to see equity curve
    </div>
  )
  const W=340, H=70
  const cumPnL = closed.reduce((acc,t)=>{
    const prev = acc[acc.length-1]?.y||0
    acc.push({y: prev+parseFloat(t.pnl||0), t: t.ticker})
    return acc
  },[])
  const vals = cumPnL.map(p=>p.y)
  const minV = Math.min(0,...vals), maxV = Math.max(0,...vals)
  const range = maxV-minV||1
  const toY = v => H - ((v-minV)/range)*H*0.85 - H*0.05
  const pts = cumPnL.map((p,i)=>`${(i/(cumPnL.length-1))*W},${toY(p.y)}`).join(' ')
  const lastY = cumPnL[cumPnL.length-1].y
  const lineColor = lastY>=0?themeC.green:themeC.red
  const zeroY = toY(0)
  return (
    <div style={{position:'relative'}}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,display:'block'}}>
        <defs>
          <linearGradient id="pgrd" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25"/>
            <stop offset="100%" stopColor={lineColor} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={themeC.border} strokeWidth={1} strokeDasharray="4,4"/>
        <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#pgrd)"/>
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.8}/>
        <circle cx={(cumPnL.length-1)/(cumPnL.length-1)*W} cy={toY(lastY)} r={3} fill={lineColor}/>
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:themeC.dim,marginTop:3,letterSpacing:.5}}>
        <span>{closed[0]?.date||closed[0]?.ticker||''}</span>
        <span>{closed[closed.length-1]?.date||closed[closed.length-1]?.ticker||''}</span>
      </div>
    </div>
  )
}

// ─── Tradier API proxy ────────────────────────────────────────────────────────
async function tradierGet(path, token, mode, authToken) {
  const headers = {}
  if (authToken) {
    // Phase 2: Clerk JWT → server uses admin TRADIER_TOKEN
    headers['Authorization'] = `Bearer ${authToken}`
  } else if (token) {
    // Phase 1 legacy / sandbox override: user-provided token
    headers['x-tradier-token'] = token
    headers['x-tradier-mode']  = mode || 'sandbox'
  } else {
    // No auth at all — still try, server may have admin token configured
    // (works when TRADIER_TOKEN is set in Vercel env vars)
  }
  const res = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, { headers })
  if (!res.ok) {
    const raw = await res.text().catch(()=>'')
    let err = {}
    try { err = JSON.parse(raw) } catch {}
    if (res.status === 429 && err.upgrade) throw new Error('USAGE_LIMIT:' + err.error)
    throw new Error(`Market data error ${res.status}: ${err.error || raw.slice(0,80)}`)
  }
  return res.json()
}

async function sendTelegram(message, token, chatId, authToken) {
  const headers = {'Content-Type':'application/json'}
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`
  const res = await fetch('/api/telegram', {
    method:'POST',
    headers,
    body:JSON.stringify({message,token,chat_id:chatId}),
  })
  return res.json()
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App(props={}) {
  // props.getToken — async function from Router that returns Clerk JWT

  // ── auth token from Router (Phase 2) ──
  const getAuthToken = props.getToken || (async () => null)
  // Phase 2: admin key is always active — no per-user token required.
  // hasDataAccess = true when admin key is set OR user has a personal token (legacy).
  // Used to gate UI elements that need market data.
  const hasDataAccess = true   // admin TRADIER_TOKEN always present on server

  // ── Cloud API helpers ──────────────────────────────────────────────────────
  const cloudGet = async (path) => {
    const token = await getAuthToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await fetch(path, { headers })
    if (!res.ok) throw new Error(`${path} ${res.status}`)
    return res.json()
  }
  const cloudPost = async (path, body, method='POST') => {
    const token = await getAuthToken()
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(path, { method, headers, body: JSON.stringify(body) })
    if (!res.ok) {
      const err = await res.json().catch(()=>({error:res.statusText}))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  }

  // ── theme ──
  const isDark    = props.isDark    ?? true
  const setIsDark = props.setIsDark ?? (() => {})
  const C         = isDark ? DARK_THEME : LIGHT_THEME
  const iSt = {
    width:'100%', background:C.inputBg, border:`1px solid ${C.border}`,
    borderRadius:4, color:C.text, padding:'9px 12px',
    fontSize:12, fontFamily:'inherit', transition:'border-color .15s',
  }

  // ── main tab & tools panel ──
  const [tab,        setTab]        = useState('dash')
  const [paperToast, setPaperToast] = useState('')        // confirmation toast
  const [showTools,  setShowTools]  = useState(false)
  const [toolsTab,   setToolsTab]   = useState('settings')
  const [feedbackText,    setFeedbackText]    = useState('')
  const [feedbackType,    setFeedbackType]    = useState('suggestion')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackSent,    setFeedbackSent]    = useState(false)
  const [feedbackErr,     setFeedbackErr]     = useState('')
  const [adminFeedback,   setAdminFeedback]   = useState([])
  const [adminFbLoading,  setAdminFbLoading]  = useState(false)
  const [adminFbErr,      setAdminFbErr]      = useState('')

  // ── settings ──
  const [tradierToken, setTradierToken] = useState(()=>ls('tradierToken'))
  const [tradierMode,  setTradierMode]  = useState(()=>ls('tradierMode','production'))
  const [tgToken,      setTgToken]      = useState(()=>ls('tgToken'))
  const [tgChatId,     setTgChatId]     = useState(()=>ls('tgChatId'))
  const [tgSaving,     setTgSaving]     = useState(false)
  const [tgSaveStatus, setTgSaveStatus] = useState('')
  // Replaces the old freeform watchlist input — that only affected a rarely
  // triggered fallback scan loop (runAutoScan), not the primary cache-read
  // path, so typing tickers into it had little visible effect most of the
  // time. This instead filters the already-fetched results by ticker name.
  const [tickerFilter, setTickerFilter] = useState('')
  const [minScore,     setMinScore]     = useState(()=>Number(ls('minScore','70')))
  const [scanFreq,     setScanFreq]     = useState(()=>Number(ls('scanFreq','5')))
  const [tgStatus,     setTgStatus]     = useState('')

  useEffect(()=>{try{localStorage.setItem('tradierToken',tradierToken)}catch{}},[tradierToken])
  useEffect(()=>{try{localStorage.setItem('tradierMode', tradierMode)} catch{}},[tradierMode])
  useEffect(()=>{try{localStorage.setItem('tgToken',     tgToken)}     catch{}},[tgToken])
  useEffect(()=>{try{localStorage.setItem('tgChatId',    tgChatId)}    catch{}},[tgChatId])
  // watchlist localStorage persistence removed along with the input itself
  useEffect(()=>{try{localStorage.setItem('minScore',    String(minScore))}catch{}},[minScore])
  useEffect(()=>{try{localStorage.setItem('scanFreq',    String(scanFreq))}catch{}},[scanFreq])

  // ── price bar ──
  const [esBar, setEsBar] = useState(null)
  const [nqBar, setNqBar] = useState(null)
  const [barLoading, setBarLoading] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState(null)
  const [nextRefresh,   setNextRefresh]   = useState(30)

  // ── index alerts & conviction ──
  const [indexAlerts,        setIndexAlerts]        = useState([])
  const [indexAlertsLoading, setIndexAlertsLoading] = useState(false)
  const [marketConviction,   setMarketConviction]   = useState(null)
  // Hero headline reads brief.why/brief.bias from MorningBrief's fetch (via
  // its onBriefLoaded callback) rather than re-fetching /api/brief separately.
  const [briefData,          setBriefData]          = useState(null)

  // ── checklist ──
  const [checked, setChecked] = useState({})
  const clScore = Math.round(Object.values(checked).filter(Boolean).length/CHECKLIST.length*100)
  const clColor = clScore>=80?C.green:clScore>=60?C.orange:C.red

  // ── alert preferences (Settings tab — source of truth) ──
  const [alertPrefs,       setAlertPrefs]       = useState({ email_alerts:false, alert_email:'', min_edge_score:50, symbols:['SPY','QQQ'] })
  const [alertPrefsLoaded, setAlertPrefsLoaded] = useState(false)
  const [alertPrefsSaving, setAlertPrefsSaving] = useState(false)
  const [alertPrefsSaved,  setAlertPrefsSaved]  = useState(false)
  const [alertPrefsErr,    setAlertPrefsErr]    = useState('')
  const [customSymInput,   setCustomSymInput]   = useState('')
  useEffect(()=>{
    if (alertPrefsLoaded) return
    getAuthToken().then(token=>{
      if (!token) { setAlertPrefsLoaded(true); return }
      fetch('/api/user/prefs',{headers:{Authorization:`Bearer ${token}`}})
        .then(r=>r.json())
        .then(d=>{
          if (d.prefs) {
            setAlertPrefs(p=>({...p,...d.prefs}))
            // Sync min_edge_score → auto-scanner minScore
            if (d.prefs.min_edge_score) setMinScore(d.prefs.min_edge_score)
          }
          setAlertPrefsLoaded(true)
        })
        .catch(()=>setAlertPrefsLoaded(true))
    }).catch(()=>setAlertPrefsLoaded(true))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  const submitFeedback = async()=>{
    if(!feedbackText.trim()) return
    setFeedbackSending(true); setFeedbackErr('')
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/user/prefs?action=feedback',{
        method:'POST',
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({type:feedbackType,message:feedbackText.trim(),email:userEmail})
      })
      if(!res.ok) throw new Error(`HTTP ${res.status}`)
      setFeedbackSent(true); setFeedbackText(''); setTimeout(()=>setFeedbackSent(false),4000)
    } catch(e){ setFeedbackErr(e.message) }
    finally { setFeedbackSending(false) }
  }

  const loadAdminFeedback = async()=>{
    setAdminFbLoading(true); setAdminFbErr('')
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/user/prefs?action=feedback',{headers:token?{Authorization:`Bearer ${token}`}:{}})
      const d = await res.json()
      if(!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setAdminFeedback(d.feedback||[])
    } catch(e){ setAdminFbErr(e.message); console.error('Admin feedback load:',e.message) }
    finally { setAdminFbLoading(false) }
  }

  const saveTgPrefs = async()=>{
    if (!isAdmin) return
    setTgSaving(true); setTgSaveStatus('')
    try {
      const token = await getAuthToken()
      const r = await fetch('/api/user/prefs',{method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({...alertPrefs, tg_token:tgToken, tg_chat_id:tgChatId})})
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setTgSaveStatus('saved'); setTimeout(()=>setTgSaveStatus(''),3000)
    } catch(e){ setTgSaveStatus('error:'+e.message) }
    finally { setTgSaving(false) }
  }

  const saveAlertPrefs = async()=>{
    setAlertPrefsSaving(true); setAlertPrefsErr('')
    // Keep minScore in sync when saving
    setMinScore(alertPrefs.min_edge_score)
    try {
      const token = await getAuthToken()
      const r = await fetch('/api/user/prefs',{method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify(alertPrefs)})
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setAlertPrefsSaved(true); setTimeout(()=>setAlertPrefsSaved(false),3000)
    } catch(e){ setAlertPrefsErr('Save failed — '+e.message) }
    finally { setAlertPrefsSaving(false) }
  }
  const toggleAlertSym = sym=>{
    setAlertPrefs(p=>{
      const has=p.symbols.includes(sym)
      if (!has && p.symbols.length>=10) return p
      return {...p, symbols: has ? p.symbols.filter(s=>s!==sym) : [...p.symbols,sym]}
    })
  }
  const addCustomSym = ()=>{
    const s=customSymInput.trim().toUpperCase()
    if (!s || alertPrefs.symbols.includes(s) || alertPrefs.symbols.length>=10) return
    setAlertPrefs(p=>({...p,symbols:[...p.symbols,s]}))
    setCustomSymInput('')
  }

  // ── journal ──
  const [trades,          setTrades]        = useState(()=>{try{return JSON.parse(ls('trades','[]'))}catch{return[]}})
  const [tradesLoaded,    setTradesLoaded]   = useState(false)
  const [tradesSyncing,   setTradesSyncing]  = useState(false)
  const [usageLimitHit,   setUsageLimitHit]  = useState(false)
  const [usageCount,      setUsageCount]     = useState(0)
  const [scanLimit]       = useState(4)  // free tier limit
  const [showAdd,  setShowAdd]  = useState(false)
  const [jFilter,  setJFilter]  = useState('All')
  const [newTrade, setNewTrade] = useState({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:'',conviction:'',iv:'',chgPctAtEntry:'',strike:'',breakevenReqPct:''})
  useEffect(()=>{try{localStorage.setItem('trades',JSON.stringify(trades))}catch{}},[trades])

  // Load trades from cloud on mount (merges with localStorage)
  useEffect(()=>{
    if (tradesLoaded) return
    getAuthToken().then(token => {
      if (!token) { setTradesLoaded(true); return }
      fetch('/api/user/trades', { headers:{ Authorization:`Bearer ${token}` } })
        .then(r=>r.json())
        .then(d=>{
          if (d.trades?.length > 0) {
            // Cloud is source of truth — replace localStorage
            setTrades(d.trades.map(t=>({
              id: t.id, ticker:t.ticker, type:t.type, status:t.status,
              entry:t.entry, exitPrice:t.exit_price, pnl:String(t.pnl||''),
              contracts:t.contracts, strike:t.strike, expiry:t.expiry,
              date:t.logged_at?.split('T')[0]||'', notes:t.notes||'',
              conviction:String(t.conviction||''), iv:String(t.iv_at_entry||''),
              chgPctAtEntry:String(t.chg_pct_at_entry||''),
              breakevenReqPct:String(t.be_req_pct||''),
              hardBlockCount:String(t.hard_block_count||0), grade:t.grade||'',
            })))
            try { localStorage.setItem('trades', JSON.stringify(d.trades)) } catch {}
          }
          setTradesLoaded(true)
        })
        .catch(()=>setTradesLoaded(true))
    }).catch(()=>setTradesLoaded(true))
  }, [])

  const jStats = (()=>{
    const closed=trades.filter(t=>t.status!=='Open')
    const wins=closed.filter(t=>parseFloat(t.pnl)>0)
    const losses=closed.filter(t=>parseFloat(t.pnl)<0)
    return {
      pnl:   closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0),
      wr:    closed.length?Math.round(wins.length/closed.length*100):0,
      aw:    wins.length?wins.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/wins.length:0,
      al:    losses.length?Math.abs(losses.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/losses.length):0,
      total: closed.length,
      open:  trades.filter(t=>t.status==='Open').length,
    }
  })()

  // ── scanner ──
  // Manual vs Auto-scanner mode toggle — was always-stacked before; matches
  // the approved mock's tab structure (one tool, two modes) instead.
  const [scanMode, setScanMode] = useState('manual')
  const [scanTicker, setScanTicker] = useState('')
  const [scanType,   setScanType]   = useState(()=>ls('scanType','Any'))
  const [scanTF,     setScanTF]     = useState(()=>ls('scanTF','Swing (21–45 DTE)'))
  useEffect(()=>{try{localStorage.setItem('scanTF',   scanTF)}   catch{}},[scanTF])
  useEffect(()=>{try{localStorage.setItem('scanType', scanType)} catch{}},[scanType])
  const [scanning,   setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanErr,    setScanErr]    = useState('')
  const [srData,      setSrData]      = useState(null)
  const [tickerBrief, setTickerBrief] = useState(null)
  const [srLoading,   setSrLoading]   = useState(false)
  const [debugLog,   setDebugLog]   = useState([])
  // activeScanTickerRef: tracks which ticker the MOST RECENTLY STARTED scan
  // was for. Used to guard the async S/R + AI brief fetch in runScan (see
  // that fetch's comment below) — without this, scanning AMZN then quickly
  // scanning NFLX before AMZN's slower /api/brief response lands would let
  // AMZN's stale brief overwrite NFLX's freshly-cleared display once it
  // finally resolves, since nothing previously checked whether a response
  // was still for the ticker currently on screen. A ref (not state) is
  // correct here specifically because this needs to be read synchronously
  // inside a .then() callback without triggering a re-render itself.
  const activeScanTickerRef = useRef('')

  // ── auto-scanner ──
  const [autoOn,      setAutoOn]      = useState(false)
  // Optional filter on the Auto-scanner's mixed-timeframe results — null
  // means show all 4 together (the new default); a value narrows to one.
  // Independent of scanTF, which still drives Manual mode's own scan.
  const [alertTfFilter, setAlertTfFilter] = useState(null)
  const [autoLog,     setAutoLog]     = useState([])
  const [lastAlert,   setLastAlert]   = useState(null)
  const [alertHistory, setAlertHistory] = useState([])   // last 10 full alert objects
  const [selectedAlert, setSelectedAlert] = useState(null) // expanded detail
  const [alertSR, setAlertSR] = useState({}) // { [alertIndex]: {loading, data} } — S/R for expanded auto-scan hits
  const [alertCopied, setAlertCopied] = useState(false)
  const autoRef    = useRef(null)
  const stopRef    = useRef(false)     // set true → running scan loop exits immediately
  const scanTFRef  = useRef(scanTF)   // always holds live scanTF — avoids stale closure in interval
  useEffect(()=>{ scanTFRef.current = scanTF },[scanTF])
  const alertTfFilterRef = useRef(alertTfFilter)   // same pattern, for loadOrRefreshAlerts' interval
  useEffect(()=>{ alertTfFilterRef.current = alertTfFilter },[alertTfFilter])

  // ── futures (tools panel) ──
  const [futSym,     setFutSym]     = useState('ES')
  const [futData,    setFutData]    = useState(null)
  const [futLoading, setFutLoading] = useState(false)
  const [futErr,     setFutErr]     = useState('')

  // ─── Tradier helpers ──────────────────────────────────────────────────────
  // Phase 2: prefer Clerk JWT (admin key). Fall back to user token for sandbox testing.
  const tGet = useCallback(async (path) => {
    const authToken = await getAuthToken().catch(()=>null)
    return tradierGet(path, tradierToken, tradierMode, authToken)
  }, [tradierToken, tradierMode, getAuthToken])
  const getQuote    = async t=>{const d=await tGet(`/markets/quotes?symbols=${t}&greeks=false`);return d?.quotes?.quote||null}
  const getExpiries = async t=>{const d=await tGet(`/markets/options/expirations?symbol=${t}&includeAllRoots=false`);return d?.expirations?.date||[]}
  const getChain    = async(t,e)=>{const d=await tGet(`/markets/options/chains?symbol=${t}&expiration=${e}&greeks=true`);return d?.options?.option||[]}

  // ─── Price bar fetch ──────────────────────────────────────────────────────
  // Direct fetch — avoids stale closure issues with useCallback chains
  const fetchPriceBar = useCallback(async()=>{
    setBarLoading(true)

    const directQuote = async (sym) => {
      try {
        // Get auth token fresh on every call
        const authToken = await getAuthToken().catch(()=>null)
        const headers = {}
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`
        else if (tradierToken) { headers['x-tradier-token']=tradierToken; headers['x-tradier-mode']=tradierMode }

        const path = `/markets/quotes?symbols=${sym}&greeks=false`
        const res  = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, { headers })
        if (!res.ok) { console.warn(`Quote ${sym}: HTTP ${res.status}`); return null }
        const data = await res.json()
        const q = data?.quotes?.quote
        if (!q) { console.warn(`Quote ${sym}: no quote in response`, data); return null }
        const last  = parseFloat(q.last      || 0)
        const close = parseFloat(q.close     || 0)
        const prev  = parseFloat(q.prevclose || 0)
        // Prefer last if it differs from prevclose (i.e. not stale pre-market)
        // Fall back to close, then prevclose
        const p = (last > 0 && last !== prev) ? last : (close > 0 ? close : prev)
        if (p <= 0) { console.warn(`Quote ${sym}: price is 0`, q); return null }
        const cp = safeChgPct(q)
        return { price:p, chgPct:cp.pct, chgEstimated:cp.estimated, chg:parseFloat(q.change||0), sym, q }
      } catch(e) {
        console.warn(`Quote ${sym} failed:`, e.message)
        return null
      }
    }

    // Try index first, ETF as fallback (SPX preferred over SPY, NDX over QQQ)
    let es = null, nq = null
    for (const sym of ['SPX','$SPX.X','SPY']) {
      es = await directQuote(sym)
      if (es) break
    }
    for (const sym of ['NDX','$NDX.X','QQQ']) {
      nq = await directQuote(sym)
      if (nq) break
    }

    if (es) setEsBar({...es, label: es.sym==='SPY'?'SPY':es.sym==='SPX'?'SPX':'SPX'})
    if (nq) setNqBar({...nq, label: nq.sym==='QQQ'?'QQQ':nq.sym==='NDX'?'NDX':'NDX'})

    if (es) {
      const spxChg = es.chgPct
      const ndxChg = nq?.chgPct || spxChg
      let bull = 50
      if (spxChg > 1.0) bull += 22
      else if (spxChg > 0.5) bull += 14
      else if (spxChg > 0.1) bull += 6
      else if (spxChg < -1.0) bull -= 22
      else if (spxChg < -0.5) bull -= 14
      else if (spxChg < -0.1) bull -= 6
      if (ndxChg > 0 && spxChg > 0) bull += 8
      else if (ndxChg < 0 && spxChg < 0) bull -= 8
      bull = Math.min(94, Math.max(6, bull))
      const dir = bull >= 62 ? 'BULLISH' : bull <= 38 ? 'BEARISH' : 'NEUTRAL'
      setMarketConviction({ score:bull, direction:dir, spxChg, ndxChg,
        color: dir==='BULLISH'?C.green:dir==='BEARISH'?C.red:C.orange })
    }
    setLastRefreshed(Date.now())
    setNextRefresh(30)
    setBarLoading(false)
  },[tradierToken, tradierMode, getAuthToken])

  // Run on mount only — fetchPriceBar already captures getAuthToken via closure
  useEffect(()=>{ fetchPriceBar() },[])
  // ── Auto-refresh price bar every 30s when tab is visible ──────────────────
useEffect(() => {
  const tick = () => {
    if (document.visibilityState === 'visible') fetchPriceBar()
  }
  const interval = setInterval(tick, 30_000)
  document.addEventListener('visibilitychange', tick)
  return () => {
    clearInterval(interval)
    document.removeEventListener('visibilitychange', tick)
  }
}, [fetchPriceBar])

  // ── Countdown ticker (1s) ─────────────────────────────────────────────────
  useEffect(() => {
    const countdown = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      setNextRefresh(prev => prev <= 1 ? 30 : prev - 1)
    }, 1_000)
    return () => clearInterval(countdown)
  }, [])

  // ─── Single ticker scan ───────────────────────────────────────────────────
  // fetchSrAndBrief: fetches S/R levels + AI commentary for a ticker in the
  // background (non-blocking — runScan doesn't await this, the trade card
  // itself renders immediately with the score/strike/entry already known).
  //
  // STALENESS GUARD: checks activeScanTickerRef.current === ticker before
  // applying EITHER setSrData or setTickerBrief. Without this, scanning
  // AMZN (kicks off this fetch) then quickly scanning NFLX before AMZN's
  // response lands would let AMZN's stale brief overwrite NFLX's display
  // once it finally resolves — confirmed live (see conversation history:
  // AMZN commentary shown under an NFLX trade card). The ref is updated
  // synchronously at the start of every runScan call, before either the
  // cache-hit or live path begins its async work, so by the time ANY
  // previous call's fetch resolves, the ref will already point to whatever
  // ticker is actually current — exactly what this check needs.
  const fetchSrAndBrief = ({ ticker, price, chgPct, iv, dte, score, tradeType }) => {
    const requestTicker = ticker
    getAuthToken().then(authTok => {
      const headers = authTok ? { Authorization: `Bearer ${authTok}` } : {}
      const qp = new URLSearchParams({
        ticker: requestTicker,
        price:     Number(price||0).toFixed(2),
        chgPct:    Number(chgPct||0).toFixed(2),
        iv:        String(iv),
        dte:       String(dte),
        score:     String(score),
        tradeType: tradeType || 'Call',
      })
      fetch(`/api/brief?${qp}`, { headers })
        .then(r => r.json())
        .then(d => {
          if (activeScanTickerRef.current !== requestTicker) return  // stale — a newer scan has since started
          if (d.sr)    setSrData(d.sr)
          if (d.brief) setTickerBrief(d.brief)
        })
        .catch(e => console.warn('[SR/Brief]', e.message))
        .finally(() => {
          if (activeScanTickerRef.current === requestTicker) setSrLoading(false)
        })
    }).catch(() => {
      if (activeScanTickerRef.current === requestTicker) setSrLoading(false)
    })
  }

  const runScan = async()=>{
    if (!scanTicker.trim()) return
    const log=[]; const dbg=m=>{log.push(m);setDebugLog([...log])}
    setScanning(true);setScanResult(null);setScanErr('');setDebugLog([])
    const ticker=scanTicker.toUpperCase()
    // Marks this ticker as the one any async response should check itself
    // against before applying — set unconditionally at the start of every
    // scan (cache-hit or live), BEFORE either path's async work begins.
    activeScanTickerRef.current = ticker
    // FIX: previously the cache-hit path below returned early without ever
    // touching srData/tickerBrief — confirmed live: scan AMZN (live path,
    // populates tickerBrief with AMZN's AI commentary) → scan NFLX where a
    // fresh cache entry exists (<20min old) → cache-hit path returns
    // immediately, AMZN's brief is still sitting in state, displayed
    // underneath the new NFLX trade card as if it were NFLX's commentary.
    // Clearing unconditionally here (before the cache-check branch) means
    // EVERY scan starts from a clean slate regardless of which path
    // (cache-hit or live) it ultimately takes.
    setSrData(null); setTickerBrief(null)

    // ── Check the cron-populated cache first ────────────────────────────────
    // If a fresh (<20min old) result already exists for this exact ticker+
    // timeframe, use it instantly instead of re-running the full live-fetch
    // sequence below. Falls through to the live path on any cache miss/error —
    // same scoring either way, since the cron runs the identical scanTicker
    // logic (api/_lib/scanLogic.js, ported from this same function).
    const SPREAD_TYPES_CHECK = ['Call Spread','Put Spread','Iron Condor','Butterfly','Strangle']
    if (!SPREAD_TYPES_CHECK.includes(scanType)) {
      try {
        dbg(`0. Checking cached scan results...`)
        // FIX: scan-cache now requires auth (it serves the paid scan results) — send the token.
        const cacheTok = await getAuthToken().catch(()=>null)
        const cacheRes = await fetch(`/api/scan-cache?ticker=${ticker}&tf=${encodeURIComponent(scanTF)}`, {
          headers: cacheTok ? { Authorization: `Bearer ${cacheTok}` } : {}
        })
        const cacheData = await cacheRes.json()
        if (cacheData?.cached && cacheData.result) {
          const row = cacheData.result
          dbg(`✓ Cache hit — scanned ${Math.round((Date.now()-new Date(row.scanned_at).getTime())/60000)}m ago`)
          setScanResult({
            ticker: row.ticker, tradeType: row.trade_type, score: row.score,
            expiryDisplay: row.expiry_display, strikeStr: row.strike_str,
            entry: row.entry, target: row.target, stop: row.stop,
            isSpread: false, legsList: [],
            grade: row.grade, confidence: row.score>=80?'High':row.score>=65?'Medium':'Low',
            bid: row.bid, ask: row.ask, mid: row.mid,
            // FIX: row.iv can be NaN if the cron's scan stored a bad value
            // (confirmed live — a cached result displayed "IV: NaN%"). Guard
            // here at the read site rather than assume the write side always
            // sanitizes it correctly.
            iv: (()=>{ const v=parseFloat(row.iv); return !isNaN(v) ? v : 0 })(), delta: row.delta,
            volume: row.volume, oi: row.oi,
            chgPct: row.chg_pct,
            reasons: row.reasons||[], warnings: row.warnings||[], hardBlocks: row.hard_blocks||[],
            dte: row.dte,
            breakeven: row.breakeven, breakevenPct: row.breakeven_pct,
            // Was missing entirely on the cache-hit path — the MOVE REQUIRED
            // card always rendered "(UP) +X%" regardless of direction, since
            // this field didn't exist yet when the cache-check code was written.
            breakevenIsPut: (row.trade_type||'').toLowerCase().includes('put'),
            sector: row.sector, industry: row.industry, marketCap: row.market_cap,
            earningsDate: row.earnings_date,
            fromCache: true, cachedAt: row.scanned_at,
          })
          // Cache-hit results previously showed NO commentary at all (this
          // path returned immediately, before the brief fetch that exists
          // further down on the live path). Fetching it here too means cache
          // hits get the same AI commentary live scans do, just via the same
          // non-blocking background pattern. Guarded by activeScanTickerRef
          // (see fetchSrAndBrief) so a slow response can't land after the
          // user has already moved on to a different ticker.
          //
          // NOTE: scan_results doesn't store a raw underlying price (mid/
          // bid/ask are pre-formatted display strings like "$4.72", and
          // chg_pct is stored as "0.30%" — see scanTicker's return shape in
          // api/_lib/scanLogic.js). /api/brief defaults price/chgPct to 0 if
          // unparseable rather than throwing, so this degrades gracefully
          // (a less-precise brief) rather than breaking — but it's an honest
          // approximation, not the exact live price at scan time. Parsing
          // the formatted strings back to numbers here rather than passing
          // raw garbage or silently sending 0.
          //
          // FIX: row.iv is ALSO a formatted percent string ("35.9%", per
          // scanTicker's `iv: fmtPct(iv)`) — NOT a raw decimal. Confirmed
          // live: tickerBrief.js's prompt builder does `parseFloat(iv)*100`,
          // expecting a raw decimal (0.359) the same way the LIVE path's
          // `iv: String(iv)` sends it (tradeData.iv is the raw decimal there).
          // Originally passed row.iv through unconverted here on the
          // cache-hit path → parseFloat("35.9%")=35.9 → *100 = 3590 →
          // AI commentary read "extreme 3590% IV" while the trade card's own
          // IV panel correctly showed 35.9% from the same underlying value —
          // caught during QA before this shipped to production. Strip the
          // '%' and divide by 100 so this path sends the same decimal shape
          // the live path always has.
          setSrLoading(true)
          fetchSrAndBrief({
            ticker,
            price: parseFloat(String(row.mid||'0').replace(/[^0-9.\-]/g,'')) || 0,
            chgPct: parseFloat(String(row.chg_pct||'0').replace(/[^0-9.\-]/g,'')) || 0,
            iv: (parseFloat(String(row.iv||'0').replace(/[^0-9.\-]/g,'')) || 0) / 100,
            dte: row.dte || '30',
            score: row.score || '50',
            tradeType: row.trade_type || 'Call',
          })
          setScanning(false)
          return
        }
        dbg(`· No fresh cache — running live scan`)
      } catch (e) { dbg(`· Cache check failed (${e.message}) — running live scan`) }
    }

    try {
      dbg(`1. Fetching live quote for $${ticker}...`)
      const quote=await getQuote(ticker)
      if (!quote) throw new Error('No quote — check ticker and token')
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')
      const chgInfo=safeChgPct(quote)
      dbg(`   ✓ $${ticker} = $${price.toFixed(2)} | chg: ${chgInfo.pct.toFixed(2)}%${chgInfo.estimated?' (pre-market est. from bid/ask)':''}`)

      dbg('2. Fetching expiry dates...')
      const expDates=await getExpiries(ticker)
      if (!expDates.length) throw new Error('No expiry dates found')
      const tfCfg=TF_CONFIG[scanTF]||TF_CONFIG['Swing (21–45 DTE)']
      const expiryRaw=pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
      const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      dbg(`   ✓ Expiry: ${expiryRaw} → ${expiryDisplay}`)

      dbg('3. Fetching options chain...')
      const chain=await getChain(ticker,expiryRaw)
      if (!chain.length) throw new Error('Empty options chain')
      dbg(`   ✓ ${chain.length} contracts`)

      const chgPct=chgInfo.pct
      const chgPctEstimated=chgInfo.estimated
      const SPREAD_TYPES = ['Call Spread','Put Spread','Iron Condor','Butterfly','Strangle']
      const isSpread     = SPREAD_TYPES.includes(scanType)
      // TWO-SIDED SCORING (this pass) — gated strictly to the auto-pick case.
      // scanType==='Any' is the ONLY case where direction was ever a guess
      // (chgPct<-0.5 → bearish) rather than something the person explicitly
      // chose from the dropdown. If they picked "Call", "Put", or any spread
      // type, that's an explicit instruction — two-sided comparison must NOT
      // override it or even run, since silently second-guessing an explicit
      // selection would be a worse outcome than the direction-guessing bug
      // this is meant to fix elsewhere. isSpread is excluded from two-sided
      // scoring entirely: spread direction is encoded in the structure choice
      // itself (Call Spread vs Put Spread are different structures, not a
      // call/put toggle on one structure), so there's no "other side" to
      // build and compare the way there is for a single naked leg.
      const isAutoPick = scanType === 'Any' && !isSpread
      const bearishGuess = scanType==='Put'||scanType==='Put Spread'||(scanType==='Any'&&chgPct<-0.5)
      let optType, tradeType, twoSidedDecision = null

      if (isAutoPick) {
        // Build + score BOTH sides on the real chain, let pickBetterSide decide.
        // This replaces the old chgPct<-0.5 guess for the 'Any' case only.
        const tfCfgForSide = tfCfg
        const buildSide = (sideType) => {
          const sideChain = chain.filter(o=>o.option_type===sideType)
          if (!sideChain.length) return null
          const stepLocal = autoStep(price)
          const tdLocal = buildNakedResult(chain, price, stepLocal, sideType, tfCfgForSide)
          if (!tdLocal) return null
          const ivLocal = tdLocal.iv||0, deltaLocal = tdLocal.delta||null
          let beReqPct = null
          if (tdLocal.mid>0) {
            const strike_ = parseFloat(tdLocal.primaryStrike||0)
            if (strike_>0) {
              const isPutA = sideType==='put'
              const bePrice_a = isPutA ? (strike_ - tdLocal.mid) : (strike_ + tdLocal.mid)
              const signedPct = ((bePrice_a / price) - 1) * 100
              beReqPct = isPutA ? -Math.abs(signedPct) : Math.abs(signedPct)
            }
          }
          const scored = scoreConviction({
            price, chgPct, chgPctEstimated, optType: sideType, iv: ivLocal, delta: deltaLocal,
            volRatio: (quote.volume||0)/((quote.average_volume||quote.volume||0)||1),
            strikeVolume: tdLocal.volume||0, pos52: (price-(quote.week_52_low||price))/(((quote.week_52_high||price)-(quote.week_52_low||price))||1),
            dte: Math.round((new Date(expiryRaw+'T12:00:00')-new Date())/(1000*60*60*24)),
            spxChgToday: esBar?.chgPct||0, ndxChgToday: nqBar?.chgPct||0, breakevenReqPct: beReqPct,
            isMorningWindow: isOpeningWindow(), fundamentals: null, now: new Date(), tf: scanTF,
            gexSign: tdLocal.gexSign, gexMagnitude01: tdLocal.gexMagnitude01,
            srPosition: null, srDistPct: null,   // S/R fetched later, async, after direction is already chosen — see note below
          })
          return { td: tdLocal, breakevenReqPct: beReqPct, ...scored }
        }
        const callSide = buildSide('call')
        const putSide  = buildSide('put')
        const picked = pickBetterSide(callSide, putSide)
        if (!picked) throw new Error('No liquid contracts found on either side')
        optType = picked.side
        tradeType = optType === 'put' ? 'Put' : 'Call'
        twoSidedDecision = { otherSideScore: picked.loser ? picked.loser.score : null, gap: picked.gap, isClose: picked.isClose }
        dbg(`   ✓ Two-sided: Call ${callSide?.score ?? '—'} vs Put ${putSide?.score ?? '—'} → chose ${tradeType.toUpperCase()}${picked.isClose ? ' (close call, gap='+picked.gap+')' : ''}`)
      } else {
        // Explicit selection (Call/Put/any spread type) — unchanged behavior,
        // no comparison run, dropdown choice is honored as-is.
        optType = bearishGuess ? 'put' : 'call'
        tradeType = scanType
      }

      const step=autoStep(price)
      const strikePct=optType==='put'?(2-tfCfg.strikePct):tfCfg.strikePct
      const tgtStrike=Math.round(price*strikePct/step)*step
      const side=chain.filter(o=>o.option_type===optType)
      if (!side.length) throw new Error(`No ${optType} contracts found`)
      const best=side.reduce((a,b)=>Math.abs(b.strike-tgtStrike)<Math.abs(a.strike-tgtStrike)?b:a)
      const bid=parseFloat(best.bid||0)
      const ask=parseFloat(best.ask||0)
      const mid=(bid+ask)/2
      if (mid===0) throw new Error('Bid/ask both $0 — no liquidity')
      // Tradier occasionally returns mid_iv as the literal string 'NaN' when its IV
      // solver fails to converge (stale/zero/crossed bid-ask, common pre-market).
      // That string is truthy, so ||0 never catches it — must validate the parsed
      // number explicitly. Same pattern already fixed in buildNakedResult/approxGEX.
      const iv=safeIV(best)
      const delta=best.greeks?.delta||null
      const theta=best.greeks?.theta||null
      dbg(`   ✓ Strike: $${best.strike}${optType==='call'?'C':'P'} | Bid: ${fmtP(bid)} | Ask: ${fmtP(ask)} | Mid: ${fmtP(mid)}`)
      dbg(`   ✓ IV: ${fmtPct(iv)} | Delta: ${delta?.toFixed(3)||'—'} | Theta: ${theta?.toFixed(3)||'—'}`)

      const vol=quote.volume||0,avgVol=quote.average_volume||vol
      const volRatio=vol/(avgVol||1)
      const ivPct=iv*100
      const now=new Date()
      const isMorningNoise=isOpeningWindow()  // ET-aware: first 30 min ET
      const isHighIV=iv>0.55&&!isSpread

      // Chasing vs earnings gap distinction:
      // 2–5% with no catalyst = chasing intraday drift → block
      // >5% = almost certainly a gap from earnings/news event → allow with context
      // This is why MDB (+8.8% earnings gap) should score, but MSTR (+3.9% intraday) should not
      const isIntraChasing = Math.abs(chgPct)>2.0 && Math.abs(chgPct)<=5.0 && !isSpread
      const isEarningsGap  = Math.abs(chgPct)>5.0 && !isSpread
      const isChasing      = isIntraChasing  // only the intraday drift case is a hard block

      // Market regime — use esBar/nqBar already in state as directional context
      const spxChgToday  = esBar?.chgPct||0
      const ndxChgToday  = nqBar?.chgPct||0
      const marketFalling= spxChgToday<-0.5 && ndxChgToday<-0.5
      const marketRising = spxChgToday>0.5  && ndxChgToday>0.5
      const hi52=quote.week_52_high||price,lo52=quote.week_52_low||price
      const pos52=(price-lo52)/((hi52-lo52)||1)
      const expiryDateObj=new Date(expiryRaw+'T12:00:00')
      const dte=Math.round((expiryDateObj-now)/(1000*60*60*24))

      // First pass — best-strike data, needed before the actual contract is
      // selected below (buildNakedResult/buildSpreadResult depend on optType,
      // which depends on chgPct/iv already being known). This pass's result is
      // provisional; the real result comes from the second call below once the
      // actual contract (and its real IV/delta) is known.
      const preliminary = scoreConviction({
        price, chgPct, chgPctEstimated, optType, iv, delta, volRatio,
        strikeVolume: best.volume||0, pos52, dte,
        spxChgToday, ndxChgToday, breakevenReqPct: null,
        isMorningWindow: isMorningNoise, fundamentals: null, now, tf: scanTF,
      })

      const tradeData = isSpread
        ? buildSpreadResult(chain, price, step, scanType, tfCfg)
        : buildNakedResult (chain, price, step, optType, tfCfg)
      if (!tradeData) throw new Error('Could not find liquid contracts for this structure')
      // IMPORTANT: override iv/delta/theta with values from the ACTUAL selected contract
      // (buildNakedResult may pick a different strike than `best`)
      const ivFinal    = tradeData.iv    || iv
      const deltaFinal = tradeData.delta || delta
      const thetaFinal = tradeData.theta || theta

      // ── Break-even, computed from the actual selected contract ───────────
      let breakevenReqPct = null
      if(!isSpread && tradeData && tradeData.mid>0){
        const strike_ = parseFloat(tradeData.primaryStrike||0)
        const isPut_  = optType === 'put'
        const bePrice_  = isPut_ ? (strike_ - tradeData.mid) : (strike_ + tradeData.mid)
        const signedPct = ((bePrice_ / price) - 1) * 100
        breakevenReqPct = isPut_ ? -Math.abs(signedPct) : Math.abs(signedPct)
      }

      // ── Final, authoritative scoring pass using the ACTUAL contract's IV/
      // delta — replaces the preliminary pass entirely rather than patching
      // its hardBlocks array in place. Previously, a stale best-strike IV%
      // could be left showing in the "skip this trade" banner even after the
      // actually-selected contract's real IV had changed it (confirmed past
      // bug: an INTC scan showed 85% in the hard-block banner but 83%
      // everywhere else) — a full re-score from real data can't drift from
      // itself the way a find-and-patch correction could.
      // Spreads use the preliminary pass since this rescoring is naked-
      // options-specific (matches the prior code's existing isSpread guard
      // on the IV-recheck, just made explicit rather than implicit).
      const { score: scoreFromCanonical, reasons, warnings, hardBlocks } = isSpread
        ? preliminary
        : scoreConviction({
            price, chgPct, chgPctEstimated, optType, iv: ivFinal, delta: deltaFinal,
            volRatio, strikeVolume: tradeData.volume||best.volume||0, pos52, dte,
            spxChgToday, ndxChgToday, breakevenReqPct,
            isMorningWindow: isMorningNoise, fundamentals: null, now, tf: scanTF,
            gexSign: tradeData.gexSign, gexMagnitude01: tradeData.gexMagnitude01,
          })
      // No-catalyst cap, hard-block cap, and the 20–95 final clamp are all
      // applied inside scoreConviction already. Fundamentals are fetched
      // asynchronously below (separate network call, own latency) and
      // weren't available to either canonical call above — score needs to
      // stay mutable here specifically to layer that adjustment on top,
      // re-clamping at the very end once fundamentals are in.
      let score = scoreFromCanonical
      dbg(`✅ Scan complete`)
      // Fetch fundamentals (Supabase → Redis → api-ninjas)
      let fund = null
      try {
        const authTok = await getAuthToken().catch(()=>null)
        const fRes = await fetch(`/api/tradier?fundamentals=${ticker}`, {
          headers: authTok ? { Authorization: `Bearer ${authTok}` } : {}
        })
        if (fRes.ok) {
          const fData = await fRes.json()
          if (fData.available) fund = fData
        }
      } catch {}
      // Apply fundamentals scoring
      if(fund){
        if(fund.market_cap && fund.market_cap > 100_000_000_000){
          score+=3;reasons.push(`Large-cap (${fund.sector||'—'})`)
        }
        if(fund.earnings_date){
          const earnDays = Math.round((new Date(fund.earnings_date)-now)/(1000*60*60*24))
          if(earnDays>=0 && earnDays<=7){
            warnings.push(`⚠️ Earnings in ${earnDays}d — IV crush risk after event`)
            if(!isEarningsGap) score-=10
          } else if(earnDays>7 && earnDays<=21){
            warnings.push(`Earnings in ${earnDays}d — factor into DTE choice`)
          }
        }
        dbg(`   ✓ Fundamentals: ${fund.sector||'—'} | MCap: ${fund.market_cap?'$'+(fund.market_cap/1e9).toFixed(0)+'B':'N/A'} | Earnings: ${fund.earnings_date||'N/A'}`)
      }

      // Final score clamp (after fundamentals adjustments) — must respect
      // the SAME specific cap the canonical module already enforced before
      // fundamentals ran (chasing → 42, other hard blocks → 48), not flatten
      // to a generic 48. A flat re-clamp here would silently reintroduce the
      // exact bug just fixed inside scoreConviction, one layer up: a +3
      // large-cap bonus after a 42%-capped chasing setup could drift it back
      // to 48% right here, even though scoreConviction got it right.
      if(hardBlocks.some(b=>b.includes('Already')&&b.includes('today'))) score=Math.min(score,42)
      else if(hardBlocks.length>0) score=Math.min(score,48)
      score=Math.min(95,Math.max(20,score))
      dbg(`   ✓ Conviction: ${score}%`)

      // Fetch S/R levels + AI brief in background (non-blocking). See
      // fetchSrAndBrief's own comment for the staleness guard — same helper
      // now used by both this live path and the cache-hit path above, so
      // there's one guarded implementation instead of two that could drift.
      setSrLoading(true)
      fetchSrAndBrief({
        ticker, price, chgPct, iv: String(iv), dte: String(dte),
        score: String(score), tradeType: tradeData.structureType || 'Call',
      })

      dbg(`   ✓ Structure: ${tradeData.structureType}`)
      dbg(`   ✓ Strike: ${tradeData.strikeStr} | Entry: ${tradeData.entry}`)
      if (tradeData.legs) tradeData.legs.forEach(l=>dbg(`      ${l}`))
      setScanResult({
        ticker,
        tradeType:     tradeData.structureType,
        score, expiryDisplay, expiryRaw,
        strikeStr:     tradeData.strikeStr,
        strikeScore:   tradeData.strikeScore||0,
        strikeQuality: tradeData.strikeQuality||'',
        gexNote:       tradeData.gexNote||'',
        gexSign:       tradeData.gexSign||'',
        // Two-sided decision visibility — null for explicit Call/Put/spread
        // picks (no comparison was run); populated only when scanType was
        // 'Any' and both sides were actually built and scored.
        directionDecision: twoSidedDecision,
        entry:         tradeData.entry,
        target:        tradeData.target,
        stop:          tradeData.stop,
        isSpread,
        legsList:      tradeData.legs||[],
        grade:score>=80?'A':score>=65?'B':'C',
        confidence:score>=80?'High':score>=65?'Medium':'Low',
        price:fmtP(price),
        bid:fmtP(tradeData.bid), ask:fmtP(tradeData.ask), mid:fmtP(tradeData.mid),
        iv:fmtPct(ivFinal),ivRaw:ivFinal,
        delta:deltaFinal?deltaFinal.toFixed(3):'—',
        theta:thetaFinal?thetaFinal.toFixed(3):'—',
        volume:tradeData.volume||best.volume||0,
        oi:tradeData.oi||best.open_interest||0,
        chgPct:chgPct.toFixed(2)+'%',
        volRatio:volRatio.toFixed(1)+'x',
        reasons,warnings,hardBlocks,
        dte, ivPct:(ivFinal*100).toFixed(1),
        // Direction-aware break-even: for naked options only (spreads have their own
        // payoff math and are excluded entirely via isSpread below).
        breakeven: isSpread ? null : (()=>{
          const s = parseFloat(tradeData.primaryStrike||best.strike)
          const isPutFinal = optType === 'put'
          return (isPutFinal ? s - tradeData.mid : s + tradeData.mid).toFixed(2)
        })(),
        breakevenPct: isSpread ? null : (()=>{
          const s = parseFloat(tradeData.primaryStrike||best.strike)
          const isPutFinal = optType === 'put'
          const bePrice = isPutFinal ? s - tradeData.mid : s + tradeData.mid
          return (((bePrice/price)-1)*100).toFixed(1)   // signed: negative = move down, positive = move up
        })(),
        breakevenIsPut: optType === 'put',
        tfLabel:tfCfg.label,tfBadge:tfCfg.badge,tfColor:tfCfg.color,
        source:'',
        // Fundamentals
        sector:       fund?.sector       || null,
        industry:     fund?.industry     || null,
        marketCap:    fund?.market_cap   || null,
        peRatio:      fund?.pe_ratio     || null,
        earningsDate: fund?.earnings_date || null,
      })
    } catch(e) {
      if (e.message.startsWith('USAGE_LIMIT:')) {
        setUsageLimitHit(true)
        setUsageCount(scanLimit+1)
        setScanErr('⚡ ' + e.message.replace('USAGE_LIMIT:',''))
      } else {
        setScanErr('❌ '+e.message)
      }
      dbg('ERROR: '+e.message)
    }
    setScanning(false)
  }

  // ─── Futures fetch ────────────────────────────────────────────────────────
  const fetchFutures = async sym=>{
    setFutLoading(true);setFutErr('');setFutData(null)
    const cfg=FUT_SYMBOLS[sym]
    try {
      // Use primary symbol directly (SPX, NDX, etc.)
      let quote = null, priceSource = cfg.display, usingFutures = false
      for (const sym of [cfg.primary, cfg.fallback]) {
        try {
          const q = await getQuote(sym)
          const p = parseFloat(q?.last||q?.prevclose||0)
          if (p) { quote=q; priceSource=sym; break }
        } catch {}
      }
      if (!quote) throw new Error(
        `No quote for ${cfg.primary}. Market data connection may need attention.`
      )
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')

      const expDates=await getExpiries(cfg.chain)
      const expiry=expDates[1]||expDates[0]
      let topCalls=[],topPuts=[],chainLen=0,tradeSetups=[]

      if (expiry) {
        const chain=await getChain(cfg.chain,expiry)
        chainLen=chain.length
        const calls=chain.filter(o=>o.option_type==='call').sort((a,b)=>(b.open_interest||0)-(a.open_interest||0))
        const puts=chain.filter(o=>o.option_type==='put').sort((a,b)=>(b.open_interest||0)-(a.open_interest||0))
        topCalls=calls.slice(0,5).map(o=>({
          strike:o.strike,oi:o.open_interest||0,vol:o.volume||0,
          bid:o.bid||0,ask:o.ask||0,mid:((o.bid||0)+(o.ask||0))/2,
          iv:o.greeks?.mid_iv?(o.greeks.mid_iv*100).toFixed(1)+'%':'—',
          delta:o.greeks?.delta?o.greeks.delta.toFixed(3):'—',
        }))
        topPuts=puts.slice(0,5).map(o=>({
          strike:o.strike,oi:o.open_interest||0,vol:o.volume||0,
          bid:o.bid||0,ask:o.ask||0,mid:((o.bid||0)+(o.ask||0))/2,
          iv:o.greeks?.mid_iv?(o.greeks.mid_iv*100).toFixed(1)+'%':'—',
          delta:o.greeks?.delta?o.greeks.delta.toFixed(3):'—',
        }))
        const expiryDisplay=new Date(expiry+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
        const chgPct_=safeChgPct(quote).pct
        const bias_=chgPct_>0.3?'bull':chgPct_<-0.3?'bear':'neutral'
        const step_=autoStep(price)
        const bestCall_=topCalls[0]?chain.filter(o=>o.option_type==='call').reduce((a,b)=>Math.abs(b.strike-Math.round(price*1.01/step_)*step_)<Math.abs(a.strike-Math.round(price*1.01/step_)*step_)?b:a):null
        const bestPut_=topPuts[0]?chain.filter(o=>o.option_type==='put').reduce((a,b)=>Math.abs(b.strike-Math.round(price*0.99/step_)*step_)<Math.abs(a.strike-Math.round(price*0.99/step_)*step_)?b:a):null
        if (bestCall_) {
          const mid=((bestCall_.bid||0)+(bestCall_.ask||0))/2
          if (mid>0) tradeSetups.push({
            type:'Call',strike:`$${bestCall_.strike}C`,expiry:expiryDisplay,
            entry:fmtP(mid*0.95)+' – '+fmtP(mid*1.05),target:fmtP(mid*1.8),stop:fmtP(mid*0.5), // futures tool — single-leg reference only
            iv:bestCall_.greeks?.mid_iv?(bestCall_.greeks.mid_iv*100).toFixed(1)+'%':'—',
            delta:bestCall_.greeks?.delta?bestCall_.greeks.delta.toFixed(3):'—',
            oi:bestCall_.open_interest||0,conviction:bias_==='bull'?'High':'Medium',color:C.green,
          })
        }
        if (bestPut_) {
          const mid=((bestPut_.bid||0)+(bestPut_.ask||0))/2
          if (mid>0) tradeSetups.push({
            type:'Put',strike:`$${bestPut_.strike}P`,expiry:expiryDisplay,
            entry:fmtP(mid*0.95)+' – '+fmtP(mid*1.05),target:fmtP(mid*1.8),stop:fmtP(mid*0.5), // futures tool — single-leg reference only
            iv:bestPut_.greeks?.mid_iv?(bestPut_.greeks.mid_iv*100).toFixed(1)+'%':'—',
            delta:bestPut_.greeks?.delta?bestPut_.greeks.delta.toFixed(3):'—',
            oi:bestPut_.open_interest||0,conviction:bias_==='bear'?'High':'Medium',color:C.red,
          })
        }
      }

      const chgPct=safeChgPct(quote).pct
      const chg=parseFloat(quote.change||0)
      const hi=parseFloat(quote.high||price)
      const lo=parseFloat(quote.low||price)
      const bias=chgPct>0.3?'Bullish':chgPct<-0.3?'Bearish':'Neutral'
      const biasColor=bias==='Bullish'?C.green:bias==='Bearish'?C.red:C.orange
      const resistance=[...new Set([...topCalls.map(s=>s.strike),parseFloat(hi.toFixed(2))])].filter(l=>l>price).sort((a,b)=>a-b).slice(0,3)
      const support=[...new Set([...topPuts.map(s=>s.strike),parseFloat(lo.toFixed(2))])].filter(l=>l<price).sort((a,b)=>b-a).slice(0,3)

      setFutData({
        sym,cfg,price,chg,chgPct,hi,lo,bias,biasColor,
        hi52:parseFloat(quote.week_52_high||price),
        lo52:parseFloat(quote.week_52_low||price),
        vol:quote.volume||0,
        open:parseFloat(quote.open||price),
        resistance,support,topCalls,topPuts,chainLen,
        tradeSetups,expiry,priceSource,usingFutures,
        fetchedAt:new Date().toLocaleTimeString(),
      })
    } catch(e) {
      setFutErr('❌ '+e.message)
    }
    setFutLoading(false)
  }

  // normalizeIvPct: r.iv arrives in two different shapes depending on which
  // caller built the source object — a formatted string like "40.2%"
  // (scanOneTicker/scanResult/indexAlerts, all via fmtPct) or a raw decimal
  // like 0.402 (alertHistory, fixed earlier this session). Detects which
  // shape it actually got rather than assuming one, so this stays correct
  // regardless of which of buildScanAlert's four call sites is using it —
  // confirmed by checking all four before writing this rather than guessing.
  const normalizeIvPct = (iv) => {
    if (iv == null || iv === '') return '—'
    if (typeof iv === 'string' && iv.includes('%')) return iv   // already formatted, e.g. "40.2%"
    const n = parseFloat(iv)
    if (isNaN(n)) return '—'
    return (n < 5 ? n * 100 : n).toFixed(0) + '%'   // <5 = raw decimal, else already percent-scale
  }

  // buildScanAlert: ONE shared template, built once with Telegram markdown
  // markers and emoji. forCopy strips those markers/emoji at the end rather
  // than maintaining a second hand-written template — this is the fix for
  // a real structural drift: an earlier version had two independently
  // written templates (TG markdown vs. COPY plain-text) that drifted apart
  // on actual CONTENT, not just formatting — confirmed live when the COPY
  // output was missing the price line entirely while the TG version had it.
  // Building from one string and sanitizing for forCopy makes that kind of
  // drift structurally impossible going forward.
  //
  // Field order and content finalized after direct feedback on real sent
  // messages (see conversation): header alone first, then what/where/when
  // (strike, expiry), then price, then entry, then target/stop, then IV +
  // skip-flag count and reasoning de-emphasized (italic — Telegram has no
  // real font-size control), then a closing app link so a forwarded/shared
  // message is traceable back to the source even without app context.
  // chgPct/today's-move was deliberately removed from the price line
  // entirely (not a dedup fix — explicit decision regardless of whether a
  // reasons-list entry also states the day's move).
  const APP_LINK = 'optionsedgeflow.com'
  const buildScanAlert = (r, forCopy = false) => {
  const sym    = r.ticker||r.sym||'—'
  const isBear = (r.tradeType||'').toLowerCase().includes('put')||
                 (r.tradeType||'').toLowerCase().includes('bear')
  const em     = isBear?'🔴📉':'🟢📈'
  const ivPct  = normalizeIvPct(r.iv)
  // Filters out any reason that just restates the dedicated IV line above
  // it (e.g. "IV 54% — moderate") — confirmed live duplication on a real
  // $ORCL alert showing "IV 54%" then "IV 54% — moderate" two lines later,
  // wasting one of only 3 reason slots on a fact already stated.
  const topReasons = (r.reasons||[]).filter(x => !/^IV\s+\d/i.test(x)).slice(0, 3)
  const flagLine = r.hardBlocks?.length
    ? `${r.hardBlocks.length} skip flag(s) — see app for details`
    : null

  // NOTE: a price line (real stock price r.price, or a labeled option-mid
  // approximation r.priceApprox for alertHistory rows) used to appear here.
  // Removed entirely per explicit decision — the $2.08-labeled-"option"
  // fallback in particular read as confusing (easy to mistake for the
  // underlying's price even with the "option" label), and rather than
  // keep it only for the r.price case and drop it only for r.priceApprox,
  // the decision was to drop price from this message ENTIRELY, no
  // exceptions, for both the real-price and approximated-price cases.
  const msg = `${em} *${(r.tradeType||'OPTION').toUpperCase()} — $${sym}*

📌 ${r.strikeStr} · Exp ${r.expiryDisplay}
📊 Entry: ${r.entry}
🎯 Target: ${r.target}  🛑 Stop: ${r.stop}

_IV ${ivPct}${flagLine ? ' · ' + flagLine : ''}_
${topReasons.length ? '_' + topReasons.join(' · ') + '_' : ''}

🔗 ${APP_LINK} · _Not financial advice_`

  if (!forCopy) return msg

  // Plain-text sanitization for the COPY button: strip markdown markers
  // (Telegram's app does NOT reformat already-typed asterisks/underscores
  // when pasted manually — confirmed live, they show as literal characters)
  // and strip emoji, since emoji-as-bullets read oddly without Telegram's
  // own rendering context. Structure/content is otherwise byte-for-byte
  // the same template — this is sanitization, not a second template.
  //
  // CAUGHT BEFORE SHIPPING: an earlier version of this also ran
  // .replace(/^\s+/gm, ...) intending to clean up any leading space left
  // by emoji removal — but with the multiline flag, ^\s+ also matches a
  // blank separator line's own newline, which collapsed every blank line
  // in the message (confirmed via isolated test: 7-line spaced message
  // became 5 lines with no blank separators at all). Removed — the emoji
  // regex's own trailing \s? already consumes the one space after each
  // emoji; nothing else needs stripping.
  return msg
    .replace(/[*_]/g, '')                     // bold/italic markers
    .replace(/[🔴📉🟢📈📌💰📊🎯🛑🔗]\s?/g, '')   // emoji used as line markers
}



  // ─── Auto scanner ─────────────────────────────────────────────────────────
  // ── scanOneTicker — unified scoring with manual runScan ──────────────────────
  // Uses identical scoring logic as the manual scanner.
  // Fundamentals (sector, market cap, earnings date) are fetched from
  // /api/fundamentals which reads Supabase → Redis → api-ninjas (in that order).
  // This keeps api-ninjas calls well within the 3000/month limit.
  //
  // TWO-SIDED SCORING (this pass): mirrors the same change in scanTicker
  // (api/_lib/scanLogic.js, used by the server-side cron). Previously optType
  // was decided BEFORE scoring from chgPct/SPX direction alone, so a stock
  // ticking up 0.2% on no real signal would only ever have its CALL side
  // built and scored, even if the put side (different strike, different
  // liquidity, different delta) was the objectively better setup at that
  // moment. Now both sides are built against the real chain and scored
  // independently; pickBetterSide chooses. Direction is a scoring OUTPUT here
  // too, not an input — same as the server path, so auto-scanner alerts from
  // the client (this function) and from the cron should no longer diverge on
  // which side they pick for the same ticker at the same moment.
  const scanOneTicker = useCallback(async (ticker, tf='Swing (21–45 DTE)', withFundamentals=false)=>{
    const tfCfg2 = TF_CONFIG[tf] || TF_CONFIG['Swing (21–45 DTE)']
    try {
      const quote=await getQuote(ticker)
      if (!quote) return null
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) return null
      const expDates=await getExpiries(ticker)
      if (!expDates.length) return null
      const expiryRaw=pickExpiry(expDates, tfCfg2.minDTE, tfCfg2.maxDTE)
      const chain=await getChain(ticker,expiryRaw)
      if (!chain.length) return null

      const chgInfo = safeChgPct(quote)
      const chgPct = chgInfo.pct
      // FIX: previously this function destructured a bare `chgPct` and passed
      // an undefined `chgPctEstimated` into scoreConviction below — the
      // pre-market estimate warning could never fire from THIS call path
      // (it works correctly in runScan, which does carry .estimated through).
      // Now carries the same .estimated flag scanTicker/runScan already do.
      const chgPctEstimated = chgInfo.estimated
      const step=autoStep(price)

      const now2=new Date()
      const isMorning2=isOpeningWindow()  // ET-aware: first 30 min ET
      const expDate2=new Date(expiryRaw+'T12:00:00')
      const dte2=Math.round((expDate2-now2)/(1000*60*60*24))

      // 52-week position (Tradier provides this in quote)
      const hi52=parseFloat(quote.week_52_high||price)
      const lo52=parseFloat(quote.week_52_low||price)
      const pos52=(price-lo52)/((hi52-lo52)||1)

      const vol=quote.volume||0, avg=quote.average_volume||vol
      const volRatio=vol/(avg||1)

      // Market regime from live index state (same as manual scan)
      const spxChgToday = esBar?.chgPct||0
      const ndxChgToday = nqBar?.chgPct||0

      // Fundamentals — fetched from /api/fundamentals (Supabase-cached, not live ninjas call)
      // Only fetched when withFundamentals=true (manual scan or when alert fires threshold)
      let fund = null
      if (withFundamentals) {
        try {
          const authTok = await getAuthToken().catch(()=>null)
          const fRes = await fetch(`/api/tradier?fundamentals=${ticker}`, {
            headers: authTok ? { Authorization: `Bearer ${authTok}` } : {}
          })
          if (fRes.ok) {
            const fData = await fRes.json()
            if (fData.available) fund = fData
          }
        } catch {}
      }

      // buildSide: builds the contract + breakeven + score for ONE side,
      // self-contained so call and put go through identical logic. Returns
      // null if that side has no liquid contracts at all (e.g. far OTM chain
      // gaps) — pickBetterSide below handles either side being null.
      const buildSide = (sideType) => {
        const side = chain.filter(o=>o.option_type===sideType)
        if (!side.length) return null
        const td = buildNakedResult(chain, price, step, sideType, tfCfg2)
        if (!td) return null

        const iv = td.iv||0, delta = td.delta||null

        let breakevenReqPct = null
        if (td.mid>0) {
          const strike_ = parseFloat(td.primaryStrike||0)
          if (strike_>0) {
            const isPutA = sideType==='put'
            const bePrice_a = isPutA ? (strike_ - td.mid) : (strike_ + td.mid)
            const signedPct = ((bePrice_a / price) - 1) * 100
            breakevenReqPct = isPutA ? -Math.abs(signedPct) : Math.abs(signedPct)
          }
        }

        const scored = scoreConviction({
          price, chgPct, chgPctEstimated, optType: sideType, iv, delta, volRatio,
          strikeVolume: td.volume||0, pos52, dte: dte2,
          spxChgToday, ndxChgToday, breakevenReqPct,
          isMorningWindow: isMorning2, fundamentals: fund, now: now2, tf,
          gexSign: td.gexSign, gexMagnitude01: td.gexMagnitude01,
          // No S/R input on this client path yet — srLevels.js's getSRLevels
          // does a Tradier /markets/history fetch designed for the manual
          // scan's single-ticker, non-blocking background pattern (see
          // runScan). Wiring it into the auto-scanner loop (up to 342 tickers
          // in sequence) would add a fetch per ticker per scan with no
          // gating yet — same risk profile as the cron's S/R fetch, but
          // without that gate built here. Left out of this pass deliberately
          // rather than silently doing it without the same cost control.
          srPosition: null, srDistPct: null,
        })

        return { td, breakevenReqPct, ...scored }
      }

      const callSide = buildSide('call')
      const putSide  = buildSide('put')
      const picked = pickBetterSide(callSide, putSide)
      if (!picked) return null

      const { side: optType, winner } = picked
      const { td, score, reasons, warnings, hardBlocks: hardBlocks2 } = winner

      const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      // Breakeven for Telegram alert
      const isPutReturn = optType === 'put'
      const bePriceReturn = td.primaryStrike
        ? (isPutReturn ? parseFloat(td.primaryStrike) - td.mid : parseFloat(td.primaryStrike) + td.mid)
        : null
      const breakeven2 = bePriceReturn != null ? bePriceReturn.toFixed(2) : null
      const breakevenPct2 = bePriceReturn != null && price > 0
        ? (((bePriceReturn / price) - 1) * 100).toFixed(1)   // signed: negative = move down for puts
        : null
      return {
        ticker,score,
        tradeType: td.structureType,
        price:fmtP(price),bid:fmtP(td.bid),ask:fmtP(td.ask),mid:fmtP(td.mid),
        iv:fmtPct(td.iv||0),delta:td.delta?td.delta.toFixed(3):'—',
        volume:td.volume||0,oi:td.oi||0,
        expiryDisplay,
        strikeStr:td.strikeStr,
        entry:td.entry,target:td.target,stop:td.stop,
        legsList:[],
        tfLabel:tfCfg2.label,tfBadge:tfCfg2.badge,tfColor:tfCfg2.color,
        grade:score>=80?'A':score>=65?'B':'C',
        chgPct:chgPct.toFixed(2)+'%',
        reasons,warnings,
        hardBlocks: hardBlocks2,   // was missing entirely — TG alerts, paper-trade journal, and
                                   // the SKIP-THIS-TRADE UI all read r.hardBlocks and silently
                                   // got nothing for every auto-scanner result, regardless of
                                   // whether a hard block actually capped the score.
        dte:          dte2,
        breakeven:    breakeven2,
        breakevenPct: breakevenPct2,
        hi52:parseFloat(quote.week_52_high||price),
        lo52:parseFloat(quote.week_52_low||price),
        // Fundamentals metadata (shown in expanded detail card)
        sector:     fund?.sector     || null,
        industry:   fund?.industry   || null,
        marketCap:  fund?.market_cap || null,
        peRatio:    fund?.pe_ratio   || null,
        earningsDate: fund?.earnings_date || null,
        // Visibility into the two-sided decision — same shape as scanTicker's
        // server-side return, so UI code can treat both paths identically.
        directionDecision: {
          otherSideScore: picked.loser ? picked.loser.score : null,
          gap: picked.gap,
          isClose: picked.isClose,
        },
      }
    } catch { return null }
  },[tradierToken,tradierMode,esBar,nqBar])

  const runAutoScan = useCallback(async()=>{
    stopRef.current = false   // reset at start of each scan run
    const activeTF = scanTFRef.current
    const tfCfgNow = TF_CONFIG[activeTF]||TF_CONFIG['Swing (21–45 DTE)']
    const shuffle=arr=>[...arr].sort(()=>Math.random()-.5)
    const tickers=shuffle(SP500)
    const ts=new Date().toLocaleTimeString()
    setAutoLog(p=>[`[${ts}] ▶ Scanning ${tickers.length} tickers · ${tfCfgNow.badge} ${tfCfgNow.label} (${activeTF})`,...p.slice(0,99)])



    for (const ticker of tickers) {
      if (stopRef.current) break   // ← exit immediately when STOP pressed
      const r=await scanOneTicker(ticker, activeTF)
      if (stopRef.current) break   // ← also check after the async fetch returns
      const ts2=new Date().toLocaleTimeString()
      if (!r){setAutoLog(p=>[`[${ts2}] $${ticker}: no data`,...p.slice(0,99)]);continue}
      setAutoLog(p=>[`[${ts2}] $${ticker}: ${r.score}% ${r.tradeType} ${r.strikeStr} mid:${r.mid}`,...p.slice(0,99)])

      // Always fetch fundamentals inline — populates Supabase for every scanned ticker
      // Uses await so it's sequential (no race conditions, no timeouts from parallel calls)
      const authTokFund = await getAuthToken().catch(()=>null) || await window?.Clerk?.session?.getToken?.().catch(()=>null)
      const fundData = await fetch(`/api/tradier?fundamentals=${ticker}`, {
        headers: authTokFund ? { Authorization: `Bearer ${authTokFund}` } : {}
      }).then(r=>r.ok?r.json():null).catch(()=>null)

      if (r.score>=minScore) {
        // Threshold hit — use fundamentals already fetched above
        let rEnriched = r
        if (fundData?.available) {
          let enrichedScore = r.score
          const enrichedWarnings = [...(r.warnings||[])]
          const enrichedReasons  = [...(r.reasons||[])]
          if (fundData.earnings_date) {
            const earnDays = Math.round((new Date(fundData.earnings_date)-new Date())/(1000*60*60*24))
            if (earnDays>=0&&earnDays<=7){ enrichedWarnings.push(`⚠️ Earnings in ${earnDays}d — IV crush risk`); enrichedScore-=10 }
            else if (earnDays>7&&earnDays<=21){ enrichedWarnings.push(`Earnings in ${earnDays}d — factor into DTE`) }
          }
          if (fundData.market_cap && fundData.market_cap>100_000_000_000){ enrichedReasons.push(`Large-cap (${fundData.sector||'—'})`); enrichedScore=Math.min(95,enrichedScore+3) }
          // Hard blocks (e.g. chasing, high IV) cap conviction regardless of fundamentals —
          // never let the enrichment step lift a score back above that ceiling.
          // FIX: previously a flat 48 regardless of WHICH hard block fired — the
          // exact bug class convictionScore.cjs's header comment documents as
          // already fixed inside the canonical scorer (point #1: chasing needs
          // 42, not 48), just reintroduced one layer up here since this
          // enrichment step re-clamps independently after scanOneTicker already
          // returned a correctly-capped score. Now checks for the chasing
          // hard block specifically (same text-match pattern runScan's own
          // post-fundamentals re-clamp already uses) before falling back to 48
          // for any other hard block.
          const isChasingBlock = (r.hardBlocks||[]).some(b=>b.includes('Already')&&b.includes('today'))
          const cappedScore = isChasingBlock ? Math.min(enrichedScore,42)
            : (r.hardBlocks?.length>0) ? Math.min(enrichedScore,48)
            : enrichedScore
          rEnriched = { ...r, score:Math.min(95,Math.max(20,cappedScore)), warnings:enrichedWarnings, reasons:enrichedReasons,
            sector:fundData.sector||null, industry:fundData.industry||null, marketCap:fundData.market_cap||null, earningsDate:fundData.earnings_date||null }
        }

        setLastAlert(rEnriched)
        setAlertHistory(p=>[{...rEnriched, alertedAt: ts2}, ...p.slice(0,9)])
        // Prepending shifts every existing row's index by one — same stale-data
        // risk as the full-replace case in runAutoLookup, just subtler. Clear so
        // an open expansion or cached S/R doesn't silently jump to a different ticker.
        setSelectedAlert(null)
        setAlertSR({})
        if (isAdmin && tgToken&&tgChatId) {
          const authTok=await getAuthToken().catch(()=>null)||await window?.Clerk?.session?.getToken?.().catch(()=>null);const res=await sendTelegram(buildScanAlert(rEnriched),tgToken,tgChatId,authTok)
          setAutoLog(p=>[`[${ts2}] 🚀 $${ticker} ${rEnriched.score}% ${rEnriched.tradeType} ${rEnriched.strikeStr} → TG: ${res.ok?'✅':'❌'+(res.description||'')}`,...p.slice(0,99)])
        } else {
          setAutoLog(p=>[`[${ts2}] 🚀 $${ticker} ${rEnriched.score}% hits threshold`,...p.slice(0,99)])
        }
      }
      await new Promise(res=>setTimeout(res,400))
    }
  },[tradierToken,tradierMode,minScore,tgToken,tgChatId,scanOneTicker])

  // Reads pre-scanned results directly — the cron keeps scan_results fresh
  // on its own schedule, so this is a single fast Supabase read, never a live
  // per-ticker loop. Falls back to the old live scan only if the read fails.
  // Independent of Manual mode's scanTF — alertTfFilter (null = all 4 mixed)
  // controls what Auto mode shows.
  const loadOrRefreshAlerts = async () => {
    try {
      // FIX: scan-cache now requires auth (it serves the paid scan results) — send the token.
      const alertsTok = await getAuthToken().catch(()=>null)
      const tfParam = alertTfFilterRef.current ? `&tf=${encodeURIComponent(alertTfFilterRef.current)}` : ''
      const res = await fetch(`/api/scan-cache?minScore=${minScore}${tfParam}`, {
        headers: alertsTok ? { Authorization: `Bearer ${alertsTok}` } : {}
      })
      const data = await res.json()
      if (!data?.cached) throw new Error(data?.reason||'lookup unavailable')
      const rows = data.results || []
      setAlertHistory(rows.map(row => ({
        ticker: row.ticker, tradeType: row.trade_type, score: row.score,
        expiryDisplay: row.expiry_display, strikeStr: row.strike_str,
        entry: row.entry, target: row.target, stop: row.stop,
        bid: row.bid, ask: row.ask, mid: row.mid, delta: row.delta,
        // FIX: this object never had a `price` field at all — scan_results
        // doesn't store the underlying stock price, only the option's own
        // bid/ask/mid (already formatted strings like "$7.20"). buildScanAlert
        // reads r.price directly into the Telegram message's "Stock:" line,
        // so with no field here it rendered literally as "undefined" —
        // confirmed live via a copy-pasted $ORCL alert. row.mid (the OPTION
        // price, not the stock price) is the only price-shaped data this
        // object has access to; using it as a labeled approximation per
        // explicit decision rather than leaving the field missing. The
        // trimmed buildScanAlert template (see below) labels this clearly
        // as the option price, not the stock price, to avoid the confusion
        // a generic "Stock:" label would create with an option-price value.
        priceApprox: row.mid,
        // FIX: row.iv is a formatted percent string from scan_results
        // (scanTicker's `iv: fmtPct(iv)` → "40.2%"), not a raw decimal.
        // The original guard here (`parseFloat(row.iv)`) correctly avoided
        // NaN but didn't account for the value still being percent-scaled —
        // parseFloat("40.2%") = 40.2, which is a real number but NOT the
        // decimal (0.402) every downstream consumer of al.iv expects (e.g.
        // the alert-row detail panel's `(al.iv*100).toFixed(0)+'%'` display,
        // and the S/R-fetch call's `iv: String(al.iv||0)` sent to
        // /api/brief). Confirmed live: an NFLX alert displayed "IV 4020%"
        // and its S/R fetch sent iv=40.2 in the request — both are this same
        // 40.2-instead-of-0.402 value propagating downstream uncorrected.
        // Same fix shape as the cache-hit brief-fetch bug found earlier this
        // session (fetchSrAndBrief) — strip formatting, divide by 100.
        iv: (()=>{ const v=parseFloat(String(row.iv||'0').replace(/[^0-9.\-]/g,'')); return !isNaN(v) ? v/100 : 0 })(),
        volume: row.volume, oi: row.oi, chgPct: row.chg_pct, dte: row.dte,
        breakeven: row.breakeven, breakevenPct: row.breakeven_pct,
        breakevenIsPut: (row.trade_type||'').toLowerCase().includes('put'),
        reasons: row.reasons||[], warnings: row.warnings||[], hardBlocks: row.hard_blocks||[],
        // FIX: was hardcoded to whatever single timeframe the request used —
        // broke the moment results could mix all 4 timeframes together, since
        // every row would show the wrong label regardless of its real value.
        // Each row carries its own timeframe column from scan_results now.
        tfLabel: TF_CONFIG[row.timeframe]?.label||row.timeframe,
        tfBadge: TF_CONFIG[row.timeframe]?.badge||'',
        tfColor: TF_CONFIG[row.timeframe]?.color||C.dim,
        alertedAt: new Date(row.scanned_at).toLocaleTimeString(),
        grade: row.grade,
      })))
      // alertHistory rows are being fully replaced by index — any cached per-row
      // S/R data (alertSR) or an open expansion (selectedAlert) now points at
      // whatever new row landed at that index, which is a different ticker.
      // Clear both so a refresh can't show stale S/R under the wrong symbol.
      setSelectedAlert(null)
      setAlertSR({})
      const note = rows.length===0
        ? ` — try lowering Min Edge Score (currently ${minScore}%+); a high bar can legitimately mean zero matches right now`
        : ''
      setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ${rows.length} result(s) · ${minScore}%+ threshold${note}`,...p.slice(0,99)])
    } catch (e) {
      setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] Lookup failed — running live: ${e.message}`,...p.slice(0,99)])
      runAutoScan()
    }
  }

  const toggleAuto=()=>{
    if (autoOn) {
      stopRef.current = true   // signals the running loop to break immediately
      clearInterval(autoRef.current)
      setAutoOn(false)
      const tfNow = scanTFRef.current
      const tfLabel = TF_CONFIG[tfNow]?.label||tfNow
      setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ◼ Stopped · was using ${tfLabel}`,...p.slice(0,99)])
    } else {
      // Re-read live scanTF so START always picks up whatever is currently selected
      const tfNow = scanTFRef.current
      const tfCfgNow = TF_CONFIG[tfNow]||TF_CONFIG['Swing (21–45 DTE)']
      setAutoOn(true)
      setAutoLog([
        `[${new Date().toLocaleTimeString()}] ▶ Started · ${tfCfgNow.badge} ${tfCfgNow.label}`,
        `[${new Date().toLocaleTimeString()}] DTE window: ${tfNow} · every ${scanFreq} min · ${minScore}%+ threshold`,
      ])
      loadOrRefreshAlerts()
      autoRef.current=setInterval(loadOrRefreshAlerts,scanFreq*60*1000)
    }
  }
  useEffect(()=>()=>clearInterval(autoRef.current),[])

  // ─── Journal helpers ──────────────────────────────────────────────────────
  const addTrade=async()=>{
    if (!newTrade.ticker) return
    const localId=Date.now()+''
    const t={...newTrade,id:localId,date:newTrade.date||new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
    setTrades(p=>[t,...p])
    setNewTrade({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:'',conviction:'',iv:'',chgPctAtEntry:'',strike:'',breakevenReqPct:''})
    setShowAdd(false)
    try {
      const token=await getAuthToken()
      if(token){
        const res=await fetch('/api/user/trades',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(t)})
        const d=await res.json()
        if(d.trade?.id) setTrades(p=>p.map(x=>x.id===localId?{...x,id:d.trade.id}:x))
      }
    } catch(e){ console.log('Cloud sync (saved locally):',e.message) }
  }
  const gradeCol=g=>g==='A+'?C.purple:g==='A'?C.green:g==='B'?C.orange:C.red
  // Auth props injected by Router.jsx in the deployed app.
  // Defaults allow the app to run standalone (artifact preview / local dev).
  const isAdmin     = props.isAdmin     || false
  const userEmail   = props.userEmail   || ''
  const userInitial = props.userInitial || ''
  const openPortal  = props.openPortal  || (()=>{})
  const onSignOut   = props.onSignOut   || (()=>{})

  // Push a scan result directly into the journal as a paper trade
  // Extracts a bare numeric strike from formatted strings like "$595C", "$595.50P",
  // or spread strings like "$595C / $600C" (takes the first number found).
  const parseStrikeNum = (strikeStr) => {
    if (!strikeStr) return null
    const m = String(strikeStr).match(/[\d.]+/)
    return m ? parseFloat(m[0]) : null
  }

  const pushToJournal = async r => {
    const localId = Date.now()+''
    const strikeNum  = parseStrikeNum(r.strikeStr)
    // r.mid and r.entry are formatted strings like "$4.10" or "$3.89 – $4.30"
    // parseFloat("$4.10") = NaN — must strip the $ first
    const parsePrice = (v) => { if (!v) return NaN; const m = String(v).match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN }
    const entryNum   = parsePrice(r.mid) || parsePrice(r.entry)
    const optionType = (r.tradeType||'Call').toLowerCase().includes('put') ? 'put' : 'call'

    const t = {
      id: localId,
      ticker:           r.ticker||r.sym||'',
      type:             r.tradeType||'Call',
      option_type:      optionType,
      action:           'buy',
      status:           'Open',
      entry:            isNaN(entryNum) ? null : entryNum,
      entry_price:      isNaN(entryNum) ? null : entryNum,
      exit_price:       null,
      pnl:              '',
      contracts:        1,
      expiration:       r.expiryDisplay||'',
      expiry:           r.expiryDisplay||'',
      strike:           strikeNum,
      strikeDisplay:    r.strikeStr||'',
      date:             new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),
      notes:            `App alert · ${r.score}% conviction · ${r.tfLabel||''}`,
      conviction:       String(r.score||''),
      iv:               r.ivPct ? String(r.ivPct)
                    : r.ivRaw ? String((r.ivRaw*100).toFixed(1))
                    : r.iv   ? String((parseFloat(r.iv)*100).toFixed(1))
                    : '',
      chgPctAtEntry:    String(r.chgPct||''),
      breakevenReqPct:  String(r.breakevenPct||''),
      hardBlockCount:   String((r.hardBlocks||[]).length),
      grade:            r.grade||'',
    }

    if (!t.ticker) {
      setPaperToast(`❌ No ticker — could not log trade`)
      setTimeout(()=>setPaperToast(''), 4000)
      return
    }

    // Show optimistic state immediately, confirm/correct once backend responds
    setTrades(p=>[t,...p])
    setPaperToast(`⏳ Logging ${t.ticker}...`)

    try {
      const token = await getAuthToken().catch(()=>null) || await window?.Clerk?.session?.getToken?.().catch(()=>null)
      if (!token) {
        setTrades(p => p.filter(x => x.id !== localId))
        setPaperToast(`❌ Not signed in — trade not saved`)
        setTimeout(()=>setPaperToast(''), 4000)
        return
      }
      const res = await fetch('/api/user/trades', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body: JSON.stringify(t)
      })
      const d = await res.json().catch(()=>null)
      if (res.ok && d?.trade?.id) {
        setTrades(p => p.map(x => x.id === localId ? { ...d.trade } : x))
        setPaperToast(`✅ ${t.ticker} logged — view in Trades tab`)
      } else {
        // Backend rejected — remove the optimistic row so the UI doesn't lie
        setTrades(p => p.filter(x => x.id !== localId))
        if (d?.code === 'SUBSCRIPTION_EXPIRED') {
          setPaperToast(`❌ Subscription expired — renew to use the trade journal`)
        } else {
          setPaperToast(`❌ ${t.ticker} not saved: ${d?.error || 'HTTP '+res.status}`)
        }
        console.error('[pushToJournal] backend rejected:', d?.error || res.status, JSON.stringify(t))
      }
    } catch (e) {
      setTrades(p => p.filter(x => x.id !== localId))
      setPaperToast(`❌ ${t.ticker} not saved: ${e.message}`)
      console.error('[pushToJournal] request failed:', e.message)
    }
    setTimeout(()=>setPaperToast(''), 4000)
  }

  // ─── Generate SPX/NDX index alerts across all timeframes ─────────────────
  const generateIndexAlerts = useCallback(async()=>{
    setIndexAlertsLoading(true); setIndexAlerts([])
    const results = []
    for (const sym of ['SPX','NDX']) {
      try {
        const quote = await getQuote(sym)
        if (!quote) continue
        const price = parseFloat(quote.last||quote.prevclose||0)
        if (!price) continue
        const expDates = await getExpiries(sym)
        if (!expDates.length) continue
        const chgPct = safeChgPct(quote).pct

        for (const [tfKey, tfCfg] of Object.entries(TF_CONFIG)) {
          try {
            const expiryRaw = pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
            if (!expiryRaw) continue
            const chain = await getChain(sym, expiryRaw)
            if (!chain.length) continue

            // Determine bias from price action
            const bearish = chgPct < -0.2
            const optType = bearish ? 'put' : 'call'
            const step = autoStep(price)
            const tgtStrike = bearish
              ? Math.round(price*(2-tfCfg.strikePct)/step)*step
              : Math.round(price*tfCfg.strikePct/step)*step
            const side = chain.filter(o=>o.option_type===optType)
            if (!side.length) continue
            const best = side.reduce((a,b)=>Math.abs(b.strike-tgtStrike)<Math.abs(a.strike-tgtStrike)?b:a)
            const bid=parseFloat(best.bid||0), ask=parseFloat(best.ask||0), mid=(bid+ask)/2
            if (mid===0) continue
            const ivRaw3=parseFloat(best.greeks?.mid_iv)
            const iv=(!isNaN(ivRaw3)&&ivRaw3>0)?ivRaw3:0, delta=best.greeks?.delta||null

            // Score — generous for indices (predictable trend vehicles)
            const vol=quote.volume||0, avg=quote.average_volume||vol
            const volRatio=vol/(avg||1)
            let score=52; const reasons=[],warnings=[]
            if(volRatio>=1.5){score+=14;reasons.push(`Volume ${volRatio.toFixed(1)}x avg`)}
            else if(volRatio<0.8){score-=8;warnings.push(`Low volume`)}
            if(Math.abs(chgPct)>=0.5){score+=12;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`)}
            else if(Math.abs(chgPct)>=0.2){score+=6}
            if(iv>=0.10&&iv<=0.40){score+=12;reasons.push(`IV ${(iv*100).toFixed(0)}% — tradeable`)}
            else if(iv>0.50){warnings.push(`Elevated IV ${(iv*100).toFixed(0)}%`)}
            if(delta&&Math.abs(delta)>=0.30&&Math.abs(delta)<=0.70){score+=10;reasons.push(`Delta ${delta.toFixed(2)}`)}
            // Bonus: both SPX + NDX moving together
            if(marketConviction&&((marketConviction.spxChg>0&&!bearish)||(marketConviction.spxChg<0&&bearish))){score+=8;reasons.push('Market aligned')}
            score=Math.min(96,Math.max(30,score))

            const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
            const td_ia = buildNakedResult(chain, price, step, optType, tfCfg)
            if (!td_ia) continue
            results.push({
              sym, tfKey, tfLabel:tfCfg.label, tfBadge:tfCfg.badge, tfColor:tfCfg.color,
              tradeType:    td_ia.structureType,
              strikeStr:    td_ia.strikeStr,
              expiryDisplay, score,
              grade:score>=90?'A+':score>=80?'A':score>=70?'B':'C',
              price:fmtP(price),
              bid:fmtP(td_ia.bid), ask:fmtP(td_ia.ask), mid:fmtP(td_ia.mid),
              iv:fmtPct(td_ia.iv), delta:td_ia.delta?td_ia.delta.toFixed(3):'—',
              entry:   td_ia.entry,
              target:  td_ia.target,
              stop:    td_ia.stop,
              legsList:[],
              reasons, warnings, chgPct:chgPct.toFixed(2)+'%',
            })
          } catch {}
        }
      } catch {}
    }
    results.sort((a,b)=>b.score-a.score)
    setIndexAlerts(results)
    setIndexAlertsLoading(false)
  },[tradierToken,tradierMode,marketConviction])

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{background:C.bg,minHeight:'100vh',fontFamily:"'IBM Plex Mono',monospace",color:C.text,paddingBottom:80,transition:'background .25s, color .25s'}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        body { font-family: 'Inter', sans-serif; }
        *{box-sizing:border-box}
        .hv{cursor:pointer;transition:opacity .15s}.hv:hover{opacity:.8}
        .si{animation:si .25s ease}@keyframes si{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .pulse{animation:pu 1.1s infinite}@keyframes pu{0%,100%{opacity:1}50%{opacity:.35}}
        input:focus,textarea:focus,select:focus{outline:none;border-color:${C.green}!important}
        select option{background:${C.inputBg}}
        .scanrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:5px}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:${C.bgDeep}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px}
        .dash-grid{display:flex;flex-direction:column;gap:0}
        .dash-left{display:flex;flex-direction:column;gap:0}
        .dash-right{display:flex;flex-direction:column;gap:0}
        @media(min-width:1024px){.dash-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}.dash-left,.dash-right{display:flex;flex-direction:column;gap:0}}
        /* Expand/collapse chevron rule (.expand-summary) moved to index.css —
           this scoped <style> tag doesn't exist in the DOM on routes that
           don't render App.jsx (e.g. /app/trades), so the rule needs to live
           somewhere truly global instead. */
      `}</style>

      <AppNav tab={tab} setTab={setTab} isDark={isDark} setIsDark={setIsDark} C={C} userInitial={userInitial} openPortal={openPortal} onSignOut={onSignOut} isAdmin={isAdmin} tradierMode={tradierMode} autoOn={autoOn} showTools={showTools} setShowTools={setShowTools}/>

      {/* /ES /NQ price bar — hidden on Dashboard, where the horizontal price
          cards already show the same SPX/NDX data; still shown on every other
          tab since it's their only price reference. */}
      {tab!=='dash' && (
      <div style={{display:'flex',alignItems:'stretch',borderTop:`1px solid ${C.border}`,background:C.bgAlt}}>
        {[
          {sym:esBar?.label||'SPX',data:esBar,color:esBar?.chgPct>=0?C.green:C.red},
          {sym:nqBar?.label||'NDX',data:nqBar,color:nqBar?.chgPct>=0?C.green:C.red},
        ].map(({sym,data,color},i)=>(
          <div key={sym} style={{flex:1,padding:'6px 14px',display:'flex',alignItems:'center',gap:9,borderRight:i===0?`1px solid ${C.border}`:'none'}}>
            <span style={{fontFamily:"'Fraunces',serif",fontSize:14,letterSpacing:0.3,color:C.subtext}}>{sym}</span>
            {data?.session==='pre'   && <span style={{fontSize:8,fontWeight:700,color:C.orange,background:`${C.orange}20`,border:`1px solid ${C.orange}40`,borderRadius:2,padding:'1px 4px',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5}}>PRE</span>}
            {data?.session==='after' && <span style={{fontSize:8,fontWeight:700,color:C.blue,background:`${C.blue}20`,border:`1px solid ${C.blue}40`,borderRadius:2,padding:'1px 4px',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5}}>AH</span>}
            {data ? (
              <>
                <span style={{fontFamily:"'Fraunces',serif",fontSize:17,letterSpacing:0.3,color:C.text}}>{data.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                <span style={{fontSize:13,color,fontWeight:700}}>{data.chgPct>=0?'+':''}{data.chgPct.toFixed(2)}%</span>
                <span style={{fontSize:12,color,opacity:.7}}>({data.chg>=0?'+':''}{data.chg.toFixed(2)})</span>
              </>
            ) : (
              <span style={{fontSize:12,color:C.dim,letterSpacing:1}}>{barLoading?'—':'—'}</span>
            )}
          </div>
        ))}
        <button className="hv" onClick={fetchPriceBar} disabled={barLoading} style={{padding:'0 12px',background:'transparent',border:'none',borderLeft:`1px solid ${C.border}`,color:barLoading?C.dim:C.blue,fontSize:13,cursor:'pointer',minWidth:36}} title="Refresh prices">
          {barLoading?<span className="pulse">·</span>:'↺'}
        </button>
      </div>
      )}

      {/* ═══════════════ MAIN CONTENT ════════════════════════════════════════ */}
      <div style={{padding:'20px 24px',maxWidth:1400,margin:'0 auto'}}>

        {/* ── DASHBOARD TAB ──────────────────────────────────────────────── */}
        {tab==='dash' && (
          <div className="si">
          {(()=>{
            // Case mismatch fix: briefData.bias is Title Case ("Bullish") per
            // the Claude prompt in api/brief.js; marketConviction.direction is
            // UPPERCASE ("BULLISH"). Normalize both before comparing — the
            // previous hero's bias-color check compared against lowercase and
            // silently never matched.
            const newsBias  = (briefData?.bias || '').toUpperCase()
            const priceBias = marketConviction?.direction || ''
            const bothKnown = newsBias && priceBias
            const agree     = bothKnown && newsBias === priceBias
            const sessionPhase = getSessionPhase()
            const sessionLabel = sessionPhase==='pre' ? 'PRE-MARKET' : sessionPhase==='after' ? 'AFTER HOURS' : sessionPhase==='open' ? 'MARKET OPEN' : 'MARKET CLOSED'
            const sessionColor = sessionPhase==='open' ? C.green : sessionPhase==='closed' ? C.dim : C.orange
            return (
          <>
          {/* ── Session badge — same boundaries as MorningBrief's own status, so the two never disagree ── */}
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,fontSize:11,color:C.dim}}>
            <span style={{width:6,height:6,borderRadius:'50%',background:sessionColor,display:'inline-block'}}/>
            <span style={{color:sessionColor,fontWeight:700,letterSpacing:1,fontFamily:"'IBM Plex Mono',monospace"}}>{sessionLabel}</span>
            <span style={{color:C.dim}}>— affects how fresh each read below can be</span>
          </div>

          {/* ── Two Reads, side by side, equal weight ── */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:8}}>
            {/* News Read */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:'18px 20px'}}>
              <div style={{display:'flex',alignItems:'center',gap:6,fontSize:10,letterSpacing:1,textTransform:'uppercase',color:C.dim,fontWeight:700,marginBottom:10}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:C.blue}}/>NEWS READ · AI reading headlines
              </div>
              <div style={{fontSize:11,color:C.dim,lineHeight:1.5,marginBottom:12}}>
                Reads today's market headlines and judges overall tone — bullish, neutral, or bearish — based on what's being reported, not price movement.
              </div>
              {briefData?.why ? (
                <>
                  <div style={{fontFamily:"'Fraunces',serif",fontWeight:600,fontSize:22,color:newsBias==='BULLISH'?C.green:newsBias==='BEARISH'?C.red:C.orange,marginBottom:8}}>
                    {briefData.bias || 'Neutral'}
                  </div>
                  <div style={{fontSize:13,color:C.text,lineHeight:1.5,marginBottom:10}}>{briefData.why}</div>
                  {briefData.risk_trigger && (
                    <div style={{fontSize:11.5,color:C.subtext}}><span style={{color:C.red,fontWeight:600}}>Risk: </span>{briefData.risk_trigger}</div>
                  )}
                </>
              ) : (
                <div style={{fontSize:11,color:C.dim,textAlign:'center',padding:'10px 0'}}>Loading Market Readout below to populate this…</div>
              )}
            </div>

            {/* Price Read */}
            <div style={{background:C.card,border:`1px solid ${marketConviction?marketConviction.color+'50':C.border}`,borderRadius:12,padding:'18px 20px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{display:'flex',alignItems:'center',gap:6,fontSize:10,letterSpacing:1,textTransform:'uppercase',color:C.dim,fontWeight:700}}>
                  <span style={{width:6,height:6,borderRadius:'50%',background:C.orange}}/>PRICE READ · SPX/NDX % change
                </div>
                <button className="hv" onClick={()=>{ fetchPriceBar(); setNextRefresh(30) }}
                  style={{fontSize:10,color:C.blue,background:`${C.blue}15`,border:`1px solid ${C.blue}50`,padding:'3px 9px',borderRadius:4,cursor:'pointer',fontFamily:"'IBM Plex Mono',monospace",fontWeight:600}}>
                  {barLoading ? '···' : `↺ ${nextRefresh}s`}
                </button>
              </div>
              <div style={{fontSize:11,color:C.dim,lineHeight:1.5,marginBottom:12}}>
                Scores how far SPX and NDX have actually moved today — pure price action, no news or context factored in.
              </div>
              {marketConviction ? (
                <>
                  <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:8}}>
                    <div style={{fontFamily:"'Fraunces',serif",fontWeight:600,fontSize:22,color:marketConviction.color}}>{marketConviction.direction.charAt(0)+marketConviction.direction.slice(1).toLowerCase()}</div>
                    <div style={{fontSize:12,color:C.dim,fontFamily:"'IBM Plex Mono',monospace"}}>{marketConviction.score}%</div>
                  </div>
                  <div style={{position:'relative',height:5,background:C.border,borderRadius:3,overflow:'hidden',marginBottom:10}}>
                    <div style={{position:'absolute',left:0,top:0,height:'100%',width:marketConviction.score+'%',background:marketConviction.color,borderRadius:3,transition:'width .6s'}}/>
                  </div>
                  <div style={{fontSize:13,color:C.text}}>SPX {marketConviction.spxChg>=0?'+':''}{marketConviction.spxChg?.toFixed(2)}% · NDX {marketConviction.ndxChg>=0?'+':''}{marketConviction.ndxChg?.toFixed(2)}%</div>
                </>
              ) : (
                <div style={{fontSize:11,color:C.dim,textAlign:'center',padding:'10px 0'}}>Fetch market data to see this read</div>
              )}
            </div>
          </div>

          {/* ── Agree/disagree note — only renders once both reads have resolved ──
               Reworded from the original ⚖/dashed-orange-border treatment, which
               read as an error state on first glance (orange + dashed border is
               the same visual language used elsewhere for warnings) even though
               this is normal, expected, informational content — the two reads
               are independent signals and disagreeing is a routine outcome, not
               a fault condition. Tone and styling now match that: neutral blue,
               solid border, phrased as a divergence observation rather than
               something needing to be explained away as "not a bug." */}
          {bothKnown && (
            agree ? (
              <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11.5,color:C.green,background:`${C.green}10`,border:`1px solid ${C.green}30`,borderRadius:8,padding:'8px 12px',marginBottom:16}}>
                <span>✓</span><span>Both reads agree — news sentiment and price action are pointing the same direction right now.</span>
              </div>
            ) : (
              <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11.5,color:C.blue,background:`${C.blue}10`,border:`1px solid ${C.blue}30`,borderRadius:8,padding:'8px 12px',marginBottom:16}}>
                <span>◐</span><span>News and price are reading differently right now — sentiment and recent price action don't always move together. Worth knowing before you size a trade off either one alone.</span>
              </div>
            )
          )}

          {/* ── Evidence — collapsed by default, supports the News Read above ── */}
          {briefData?.why && (
            <details style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,marginBottom:16}}>
              <summary className="expand-summary" style={{padding:'13px 18px',fontSize:12.5,fontWeight:600,color:C.text,cursor:'pointer',listStyle:'none'}}>
                Evidence behind the news read <span style={{color:C.dim,fontWeight:400,marginLeft:6}}>— the headlines and price levels behind this read</span>
                <span className="expand-hint">tap to expand</span>
              </summary>
              <div style={{padding:'0 18px 16px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
                <div>
                  <div style={{fontSize:10,letterSpacing:1.3,textTransform:'uppercase',color:C.dim,fontWeight:700,marginBottom:10}}>What's happening</div>
                  {(briefData.events||[]).map((ev,i)=>(
                    <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:6}}>
                      <span style={{width:5,height:5,borderRadius:'50%',background:C.green,flexShrink:0,marginTop:6}}/>
                      <span style={{fontSize:12.5,color:C.subtext,lineHeight:1.5}}>{ev}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{fontSize:10,letterSpacing:1.3,textTransform:'uppercase',color:C.dim,fontWeight:700,marginBottom:10}}>Key levels</div>
                  {(briefData.levels||[]).map((lv,i)=>(
                    <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:6}}>
                      <span style={{color:C.blue,fontWeight:700,flexShrink:0}}>→</span>
                      <span style={{fontSize:12.5,color:C.subtext,fontFamily:"'IBM Plex Mono',monospace",lineHeight:1.5}}>{lv}</span>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
          </>
            )
          })()}

          <div className="dash-grid">
          <div className="dash-left">

            {/* ── SPX / NDX price cards ── */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
              {[
                {sym:esBar?.label||'SPX',data:esBar},
                {sym:nqBar?.label||'NDX',data:nqBar},
              ].map(({sym,data})=>{
                const up=data?.chgPct>=0
                const bc=data?up?C.green:C.red:C.dim
                return (
                  <div key={sym} style={{background:C.card,border:`1px solid ${data?bc+'40':C.border}`,borderLeft:`3px solid ${bc}`,borderRadius:10,padding:'14px 16px',boxShadow:C.shadow}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}}>
                      <span style={{fontFamily:"'Fraunces',serif",fontSize:17,letterSpacing:0.3,color:bc}}>{sym}</span>
                      {data && <span style={{fontSize:10,color:bc,border:`1px solid ${bc}40`,padding:'1px 4px',borderRadius:3}}>{up?'▲':'▼'}</span>}
                    </div>
                    <div style={{fontFamily:"'Fraunces',serif",fontSize:26,color:C.text,letterSpacing:0.3,lineHeight:1.1}}>
                      {data?data.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}
                    </div>
                    {data && <div style={{fontSize:12,color:bc,marginTop:2}}>{up?'+':''}{data.chgPct.toFixed(2)}%</div>}
                  </div>
                )
              })}
            </div>

            {/* ── No data CTA ── */}
            {!esBar && !nqBar && !barLoading && (
              <div style={{background:C.bgDeep,border:`1px dashed ${C.border}`,borderRadius:10,padding:'11px 13px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',boxShadow:C.shadow}}>
                <div>
                  <div style={{fontSize:12,color:C.orange,marginBottom:2}}>⚠ Market data unavailable</div>
                  <div style={{fontSize:11,color:C.dim}}>Click refresh to retry. Check Vercel logs if issue persists.</div>
                </div>
                <button className="hv" onClick={()=>{ fetchPriceBar(); setNextRefresh(30) }}
                  style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:4,fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}>
                  {barLoading ? '⏳ refreshing...' : `↺ ${nextRefresh}s`}
                </button>
      </div>
            )}
            {!esBar && !nqBar && barLoading && (
              <div style={{background:C.bgDeep,border:`1px dashed ${C.border}`,borderRadius:10,padding:'11px 13px',marginBottom:12,boxShadow:C.shadow}}>
                <div style={{fontSize:12,color:C.dim}}>⏳ Loading market data...</div>
              </div>
            )}

            {/* ── Today's Signals (SPX/NDX, was "Index Setups") ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'16px 20px',marginBottom:12,boxShadow:C.shadow}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div>
                  <div style={{fontSize:12,color:C.dim,letterSpacing:1,fontWeight:700,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>TODAY'S SIGNALS</div>
                  <div style={{fontSize:11,color:C.subtext,marginTop:2}}>SPX / NDX {'·'} all timeframes {'·'} sorted by conviction</div>
                </div>
                <button className="hv" onClick={generateIndexAlerts} disabled={indexAlertsLoading} style={{
                  background: indexAlertsLoading ? C.cardAlt : C.green,
                  border: `1px solid ${indexAlertsLoading ? C.border : C.green}`,
                  color: indexAlertsLoading ? C.dim : '#000',
                  fontWeight: 700,
                  padding:'8px 18px',borderRadius:4,fontSize:12,letterSpacing:.8,
                  cursor:indexAlertsLoading?'not-allowed':'pointer',
                  fontFamily:"'Fraunces',serif",
                }}>
                  {indexAlertsLoading?<span className="pulse">SCANNING</span>:'GENERATE'}
                </button>
              </div>
              {indexAlerts.length===0 && !indexAlertsLoading && (
                <div style={{fontSize:12,color:C.subtext,textAlign:'center',padding:'10px 0'}}>
                  {'Hit GENERATE to scan SPX & NDX across all 4 timeframes'}
                </div>
              )}
              {indexAlerts.slice(0,6).map((al,i)=>{
                const high=al.score>=90; const midHit=al.score>=75
                const cardC=high?C.green:midHit?C.blue:C.dim
                return (
                  <div key={i} style={{display:'flex',gap:10,padding:'10px 0',borderBottom:i<indexAlerts.slice(0,6).length-1?`1px solid ${C.borderDim}`:'none'}}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:cardC,marginTop:5,flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:3}}>
                        <span style={{fontFamily:"'Fraunces',serif",fontSize:16,color:cardC,letterSpacing:0.3}}>{al.sym}</span>
                        <span style={{fontSize:12,color:C.text}}>{al.tradeType} {al.strikeStr}</span>
                        <span style={{fontSize:10,color:al.tfColor,border:`1px solid ${al.tfColor}40`,padding:'1px 6px',borderRadius:2,whiteSpace:'nowrap'}}>{al.tfLabel||al.tfBadge}</span>
                        {high&&<span style={{fontSize:10,fontWeight:700,color:C.purple,background:`${C.purple}15`,border:`1px solid ${C.purple}50`,padding:'1px 7px',borderRadius:4}}>HIGH CONVICTION</span>}
                        <span style={{fontFamily:"'Fraunces',serif",fontSize:14,color:cardC,marginLeft:'auto'}}>{al.score}%</span>
                      </div>
                      <div style={{fontSize:11.5,color:C.subtext}}>
                        Entry {al.entry} {'·'} Tgt <span style={{color:C.green}}>{al.target}</span> {'·'} Stp <span style={{color:C.red}}>{al.stop}</span> {'·'} Exp {al.expiryDisplay} {'·'} IV {al.iv}
                      </div>
                      {al.reasons.length>0&&<div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:4}}>{al.reasons.map((r,j)=><span key={j} style={{fontSize:10.5,color:cardC,background:`${cardC}10`,padding:'1px 5px',borderRadius:2}}>{r}</span>)}</div>}
                      {(al.sector||al.earningsDate)&&<div style={{display:'flex',flexWrap:'wrap',gap:4,marginTop:4}}>
                        {al.sector&&<span style={{fontSize:10,padding:'1px 6px',background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:3,color:C.subtext}}>{al.sector}</span>}
                        {al.marketCap&&<span style={{fontSize:10,padding:'1px 6px',background:C.bgDeep,border:`1px solid ${C.blue}30`,borderRadius:3,color:C.blue}}>MCap ${(al.marketCap/1e9).toFixed(0)}B</span>}
                        {al.earningsDate&&(()=>{const d=Math.round((new Date(al.earningsDate)-new Date())/(864e5));const clr=d>=0&&d<=7?C.red:d<=21?C.orange:C.subtext;return<span style={{fontSize:10,padding:'1px 6px',background:C.bgDeep,border:`1px solid ${clr}`,borderRadius:3,color:clr}}>📅 Earnings {d>=0?`in ${d}d`:`${Math.abs(d)}d ago`}</span>})()}
                      </div>}
                      {isAdmin&&tgToken&&tgChatId&&(
                        <button className="hv" onClick={async()=>{const aTok=await getAuthToken().catch(()=>null);await sendTelegram(buildScanAlert({...al,ticker:al.sym}),tgToken,tgChatId,aTok);setTgStatus('Sent!');setTimeout(()=>setTgStatus(''),3000)}} style={{marginTop:5,background:`${C.blue}18`,border:`1px solid ${C.blue}40`,color:C.blue,padding:'3px 9px',borderRadius:3,fontSize:11,cursor:'pointer'}}>TG</button>
                      )}
                    </div>
                  </div>
                )
              })}
              {tgStatus&&<div style={{fontSize:12,color:C.green,marginTop:4}}>{tgStatus}</div>}
            </div>

            </div>{/* end dash-left */}
            <div className="dash-right">

            {/* ── Market Readout ── */}
            <MorningBrief getToken={getAuthToken} theme={C} isAdmin={isAdmin} onBriefLoaded={setBriefData} />

            {/* ── Checklist ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'16px 20px',marginBottom:12,boxShadow:C.shadow}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:7}}>
                <div style={{fontSize:12,color:C.dim,letterSpacing:1,fontWeight:700,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>PRE-TRADE CHECKLIST</div>
                <button className="hv" onClick={()=>{setToolsTab('checklist');setShowTools(true)}} style={{fontSize:12,color:'#1c1916',background:C.blue,border:'none',padding:'8px 18px',borderRadius:4,cursor:'pointer',fontWeight:700,fontFamily:"'Fraunces',serif",letterSpacing:0.3}}>OPEN</button>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
                <div style={{fontFamily:"'Fraunces',serif",fontSize:40,color:clColor,letterSpacing:0.3,lineHeight:1}}>{clScore}%</div>
                <div>
                  <div style={{fontSize:11,color:clScore>=80?C.green:clScore>=60?C.orange:C.red}}>{clScore>=80?'STRONG SETUP':clScore>=60?'CAUTION':'SKIP THIS TRADE'}</div>
                  <div style={{fontSize:11,color:C.dim,marginTop:1}}>{Object.values(checked).filter(Boolean).length}/{CHECKLIST.length} checks</div>
                </div>
              </div>
              <div style={{width:'100%',height:4,background:C.border,borderRadius:2,overflow:'hidden'}}>
                <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s',borderRadius:2}}/>
              </div>
            </div>

            {/* ── Journal summary ── */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:4}}>
              {[
                {l:'TOTAL P&L',v:(jStats.pnl>=0?'+':'-')+'$'+Math.abs(jStats.pnl).toFixed(0),c:jStats.pnl>=0?C.green:C.red},
                {l:'WIN RATE', v:jStats.wr+'%',c:jStats.wr>=60?C.green:jStats.wr>=45?C.orange:C.red},
                {l:'OPEN',     v:String(jStats.open),c:C.blue},
              ].map((s,i)=>(
                <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderTop:`3px solid ${s.c}`,borderRadius:10,padding:'9px 11px',boxShadow:C.shadow}}>
                  <div style={{fontSize:12,color:C.dim,letterSpacing:1,fontWeight:700,fontFamily:"'Inter',sans-serif",textTransform:'uppercase',marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:28,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
            <Link to="/app/trades" style={{display:'block',textAlign:'center',padding:'12px 16px',borderRadius:10,marginBottom:4,border:`1px solid ${C.blue}40`,color:C.blue,fontSize:13,fontWeight:600,letterSpacing:1.5,textDecoration:'none',background:`${C.blue}10`,boxShadow:C.shadow,fontFamily:"'Inter',sans-serif"}}>≡ VIEW FULL TRADE LOG & BACKTEST →</Link>
            </div>{/* end dash-right */}
          </div>{/* end dash-grid */}
          </div>
        )}

        {/* ── SCAN TAB ────────────────────────────────────────────────────── */}
        {tab==='scan' && (
          <div className="si">
            {usageLimitHit && (
              <div style={{background:C.bgDeep,border:`1px solid ${C.orange}50`,borderRadius:6,padding:'10px 13px',marginBottom:11,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
                <div>
                  <div style={{fontSize:11,color:C.orange,marginBottom:2}}>⚡ Daily scan limit reached ({usageCount}/{scanLimit})</div>
                  <div style={{fontSize:12,color:C.subtext}}>Free tier: {scanLimit} scans/day. Resets at midnight UTC.</div>
                </div>
                <button className="hv" onClick={()=>window.location.href='/app'} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'6px 12px',borderRadius:4,fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}>UPGRADE →</button>
              </div>
            )}

            {/* ── Mode toggle: Manual vs Auto-scanner, one tool not two stacked panels ── */}
            <div style={{display:'flex',gap:6,marginBottom:16}}>
              <button className="hv" onClick={()=>setScanMode('manual')} style={{
                fontSize:12.5,fontWeight:600,padding:'9px 18px',borderRadius:8,cursor:'pointer',display:'flex',alignItems:'center',gap:6,
                border:`1px solid ${scanMode==='manual'?C.orange:C.border}`,
                background:scanMode==='manual'?`${C.orange}14`:C.card,
                color:scanMode==='manual'?C.orange:C.dim,
              }}>🔍 Manual</button>
              <button className="hv" onClick={()=>setScanMode('auto')} style={{
                fontSize:12.5,fontWeight:600,padding:'9px 18px',borderRadius:8,cursor:'pointer',display:'flex',alignItems:'center',gap:6,
                border:`1px solid ${scanMode==='auto'?C.orange:C.border}`,
                background:scanMode==='auto'?`${C.orange}14`:C.card,
                color:scanMode==='auto'?C.orange:C.dim,
              }}>📡 Auto-scanner <span style={{width:6,height:6,borderRadius:'50%',background:autoOn?C.green:C.dim,display:'inline-block',boxShadow:autoOn?`0 0 6px ${C.green}`:'none'}}/> {autoOn?'ON':'OFF'}</button>
            </div>

            {scanMode==='manual' && (<>
            {/* Timeframe */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:12,color:C.dim,letterSpacing:1,fontWeight:700,fontFamily:"'Inter',sans-serif",textTransform:'uppercase',marginBottom:7}}>TIMEFRAME</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {Object.entries(TF_CONFIG).map(([key,cfg])=>{
                  const active=scanTF===key
                  return (
                    <button key={key} className="hv" onClick={()=>{setScanTF(key);setScanResult(null)}} style={{
                      padding:'12px 14px',borderRadius:10,cursor:'pointer',textAlign:'left',
                      background:active?`${cfg.color}18`:C.card,
                      border:`1px solid ${active?cfg.color:C.border}`,
                      boxShadow:C.shadow,
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                        <span style={{fontSize:13}}>{cfg.badge}</span>
                        <span style={{fontFamily:"'Inter',sans-serif",fontWeight:600,fontSize:13,letterSpacing:0,color:active?cfg.color:C.text}}>{cfg.label}</span>
                        {active&&<span style={{marginLeft:'auto',fontSize:11,color:cfg.color,border:`1px solid ${cfg.color}`,padding:'1px 4px',borderRadius:2}}>ACTIVE</span>}
                      </div>
                      <div style={{fontSize:12,color:active?cfg.color+'cc':C.dim}}>{cfg.desc}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Ticker + Type */}
            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:9,marginBottom:11}}>
              <div>
                <div style={{fontSize:11,fontWeight:600,color:C.dim,letterSpacing:0.5,marginBottom:4,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>Ticker Symbol</div>
                <input value={scanTicker} onChange={e=>{setScanTicker(e.target.value.toUpperCase());setScanResult(null)}}
                  placeholder="NVDA, AAPL, SPY..." onKeyDown={e=>e.key==='Enter'&&runScan()}
                  style={{...iSt,fontSize:24,fontFamily:"'Fraunces',serif",letterSpacing:0.3,padding:'14px 16px',borderRadius:10,boxShadow:scanTicker?C.shadow:'none'}}/>
              </div>
              <Field label="Type" value={scanType} onChange={setScanType} options={['Any','Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']} C={C}/>
            </div>

            <button className="hv" onClick={runScan} disabled={scanning||!scanTicker} style={{
              width:'100%',padding:'15px',borderRadius:10,fontSize:15,letterSpacing:2,cursor:'pointer',
              fontFamily:"'Fraunces',serif",marginBottom:12,
              background: scanning ? `${C.green}15` : !scanTicker ? C.cardAlt : C.green,
              border: `1px solid ${scanning||!scanTicker ? C.border : C.green}`,
              color: scanning ? C.dim : !scanTicker ? C.dim : '#1c1916',
              fontWeight: 700,
              boxShadow:scanning?'none':C.shadow,
            }}>
              {scanning?<span className="pulse">🔴 FETCHING LIVE DATA — ${scanTicker}...</span>:`🔍 SCAN $${scanTicker||'TICKER'} — LIVE MARKET DATA`}
            </button>

            {scanErr&&<div style={{background:C.bgDeep,border:`1px solid ${C.red}40`,borderRadius:6,padding:11,color:C.red,fontSize:12,marginBottom:11,lineHeight:1.6}}>{scanErr}</div>}

            {debugLog.length>0&&(
              <div style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:6,padding:11,marginBottom:11,maxHeight:140,overflowY:'auto'}}>
                <Lbl C={C}>📡 Live Market Feed</Lbl>
                {debugLog.map((l,i)=>(
                  <div key={i} style={{fontSize:11,color:l.startsWith('✅')?C.green:l.includes('ERROR')||l.includes('❌')?C.red:C.subtext,fontFamily:'monospace',lineHeight:1.7}}>{l}</div>
                ))}
              </div>
            )}

            {/* ═══ SCAN RESULT CARD ═══════════════════════════════════════════ */}
            {scanResult&&(
              <div className="si">

                {/* ── Header: grade + ticker + structure ── */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14,flexWrap:'wrap',gap:8}}>
                  <div style={{display:'flex',gap:12,alignItems:'center'}}>
                    <div style={{fontFamily:"'Fraunces',serif",fontWeight:600,fontSize:42,color:gradeCol(scanResult.grade),lineHeight:1}}>{scanResult.grade}</div>
                    <div>
                      <div style={{fontFamily:"'Fraunces',serif",fontWeight:600,fontSize:19,color:C.text}}>${scanResult.ticker}</div>
                      <div style={{fontSize:12,color:gradeCol(scanResult.grade),fontWeight:600,marginBottom:2}}>{scanResult.tradeType}</div>
                      <div style={{fontSize:11,color:C.dim}}>Conviction: <span style={{color:scanResult.score>=80?C.green:C.orange,fontWeight:600}}>{scanResult.score}%</span> · {scanResult.confidence}</div>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginTop:4,flexWrap:'wrap'}}>
                        <div style={{display:'inline-flex',alignItems:'center',gap:5,padding:'2px 7px',borderRadius:4,background:`${scanResult.tfColor}18`,border:`1px solid ${scanResult.tfColor}40`}}>
                          <span style={{fontSize:12}}>{scanResult.tfBadge}</span>
                          <span style={{fontSize:11,color:scanResult.tfColor,letterSpacing:.5}}>{scanResult.tfLabel}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    <button className="hv" onClick={()=>pushToJournal(scanResult)} style={{background:C.orange,border:'none',color:C.bg,fontWeight:700,padding:'7px 13px',borderRadius:6,fontSize:12,cursor:'pointer'}}>📋 PAPER TRADE</button>
                    {isAdmin&&tgToken&&tgChatId&&(
                      <button className="hv" onClick={async()=>{const aTok2=await getAuthToken().catch(()=>null);const r=await sendTelegram(buildScanAlert(scanResult),tgToken,tgChatId,aTok2);setTgStatus(r.ok?'✅ Sent!':'❌ '+r.description);setTimeout(()=>setTgStatus(''),4000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'7px 13px',borderRadius:6,fontSize:12,cursor:'pointer'}}>📤 TG</button>
                    )}
                    <TweetShare result={scanResult} isAdmin={isAdmin} getToken={getAuthToken} C={C} />
                    {tgStatus&&<span style={{fontSize:12,color:C.green}}>{tgStatus}</span>}
                  </div>
                </div>

                {/* ── Hard block banners ── */}
                {scanResult.hardBlocks?.length>0&&(
                  <div style={{marginBottom:11}}>
                    {scanResult.hardBlocks.map((b,i)=>(
                      <div key={i} style={{background:C.bgDeep,border:`1px solid ${C.red}60`,borderRadius:5,padding:'9px 13px',marginBottom:5,display:'flex',gap:8,alignItems:'flex-start'}}>
                        <span style={{fontSize:14,flexShrink:0}}>🚫</span>
                        <div>
                          <div style={{fontSize:11,color:C.red,letterSpacing:1.5,marginBottom:2}}>SKIP THIS TRADE</div>
                          <div style={{fontSize:11,color:C.red,lineHeight:1.6}}>{b}</div>
                        </div>
                      </div>
                    ))}
                    <div style={{fontSize:11,color:C.subtext,padding:'5px 10px',borderRadius:3,background:C.bgDeep,border:`1px solid ${C.red}30`,lineHeight:1.6}}>
                      ⚠️ Score capped at 48% until resolved. Each flag above has a suggested fix — address it before sizing in.
                    </div>
                  </div>
                )}

                {/* ── PRIMARY TRADE BOX: strike + real option prices ── */}
                <div style={{background:isDark?C.bgDeep:C.cardAlt,border:`1px solid ${C.green}50`,borderRadius:6,padding:'12px 14px',marginBottom:11,boxShadow:C.shadowMd}}>
                  <div style={{fontSize:11,color:C.green,letterSpacing:2,marginBottom:8}}>
                    {scanResult.isSpread ? 'SPREAD EXECUTION' : 'OPTION TRADE'}
                    {' — '}{scanResult.tradeType}
                  </div>

                  {/* Strike + Expiry prominently */}
                  <div style={{display:'flex',gap:14,alignItems:'baseline',marginBottom:10,flexWrap:'wrap'}}>
                    <div>
                      <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:2}}>STRIKE</div>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:26,color:C.text,letterSpacing:0.3,lineHeight:1}}>{scanResult.strikeStr}</div>
                    </div>
                    <div>
                      <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:2}}>EXPIRY</div>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:18,color:C.text,letterSpacing:0.3}}>{scanResult.expiryDisplay}</div>
                    </div>
                    {!scanResult.isSpread&&(
                      <div>
                        <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:2}}>OPTION PRICE (MID)</div>
                        <div style={{fontFamily:"'Fraunces',serif",fontSize:22,color:C.green,letterSpacing:0.3}}>{scanResult.mid}</div>
                      </div>
                    )}
                  </div>

                  {/* Break-even row */}
                  {!scanResult.isSpread&&scanResult.breakeven&&(
                    <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10,padding:'6px 10px',borderRadius:4,background:C.bgDeep,border:`1px solid ${C.blue}30`}}>
                      <div>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>BREAK-EVEN AT EXPIRY</div>
                        <div style={{fontFamily:"'Fraunces',serif",fontSize:16,color:C.blue,letterSpacing:0.3}}>${scanResult.breakeven}</div>
                      </div>
                      <div style={{width:1,height:28,background:C.border}}/>
                      <div>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>MOVE REQUIRED {scanResult.breakevenIsPut?'(DOWN)':'(UP)'}</div>
                        <div style={{fontFamily:"'Fraunces',serif",fontSize:16,color:Math.abs(parseFloat(scanResult.breakevenPct))>5?C.red:Math.abs(parseFloat(scanResult.breakevenPct))>3?C.orange:C.green,letterSpacing:0.3}}>{scanResult.breakevenIsPut?'−':'+'}{Math.abs(parseFloat(scanResult.breakevenPct)).toFixed(1)}%</div>
                      </div>
                      <div style={{width:1,height:28,background:C.border}}/>
                      <div>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>DTE</div>
                        <div style={{fontFamily:"'Fraunces',serif",fontSize:16,color:scanResult.dte<14?C.red:scanResult.dte<21?C.orange:C.green,letterSpacing:0.3}}>{scanResult.dte}</div>
                      </div>
                    </div>
                  )}

                  {/* Bid / Ask / Mid for naked; or Net Cost for spreads */}
                  {!scanResult.isSpread ? (
                    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:10}}>
                      {[
                        {l:'BID',  v:scanResult.bid, c:C.red},
                        {l:'ASK',  v:scanResult.ask, c:C.green},
                        {l:'MID',  v:scanResult.mid, c:C.blue},
                      ].map((f,i)=>(
                        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:'6px 8px',textAlign:'center'}}>
                          <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{f.l}</div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:18,color:f.c}}>{safe(f.v)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{background:C.bgDeep,borderRadius:4,padding:'8px 10px',marginBottom:10,fontSize:11,color:C.subtext,lineHeight:1.5}}>
                      <span style={{color:C.blue,letterSpacing:1}}>NET COST — </span>
                      Debit/credit shown per leg below. Buy the spread at net debit or collect net credit.
                    </div>
                  )}

                  {/* Entry / Target / Stop */}
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:5}}>
                    {[
                      {l:'ENTRY',  v:scanResult.entry,  c:C.blue},
                      {l:'TARGET', v:scanResult.target, c:C.green},
                      {l:'STOP',   v:scanResult.stop,   c:C.red},
                    ].map((f,i)=>(
                      <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:'7px 9px'}}>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{f.l}</div>
                        <div style={{fontSize:12,color:f.c,fontWeight:600,lineHeight:1.5}}>{f.v}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── AI commentary — subordinate to the score above, not a second verdict.
                     tickerBrief's prompt already includes scanResult.score as input, so this
                     is annotation on that score, not an independent second read. ── */}
                {tickerBrief && (
                  <div style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:10,padding:'13px 16px',marginBottom:11}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:7}}>
                      <span style={{fontSize:10,letterSpacing:1,textTransform:'uppercase',color:C.dim,fontWeight:700}}>AI commentary on this score</span>
                      {tickerBrief.bias && (
                        <span style={{padding:'1px 7px',borderRadius:3,fontSize:10,fontWeight:600,
                          background:tickerBrief.tone==='bullish'?`${C.green}18`:tickerBrief.tone==='bearish'?`${C.red}18`:`${C.orange}18`,
                          color:tickerBrief.tone==='bullish'?C.green:tickerBrief.tone==='bearish'?C.red:C.orange,
                          border:`1px solid ${tickerBrief.tone==='bullish'?C.green:tickerBrief.tone==='bearish'?C.red:C.orange}40`}}>
                          {tickerBrief.bias}
                        </span>
                      )}
                    </div>
                    <div style={{fontSize:12.5,color:C.subtext,lineHeight:1.6,marginBottom:7}}>{tickerBrief.summary}</div>
                    <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                      <span style={{fontSize:10.5,color:C.orange,letterSpacing:.5,flexShrink:0,marginTop:1}}>CATALYST</span>
                      <span style={{fontSize:11.5,color:C.text,lineHeight:1.5}}>{tickerBrief.catalyst}</span>
                    </div>
                  </div>
                )}

                {/* ── Legs breakdown (only for spreads) ── */}
                {scanResult.isSpread&&scanResult.legsList?.length>0&&(
                  <div style={{background:C.bgDeep,border:`1px solid ${C.blue}40`,borderRadius:6,padding:'10px 13px',marginBottom:11}}>
                    <div style={{fontSize:11,color:C.blue,letterSpacing:2,marginBottom:8}}>LEG-BY-LEG EXECUTION</div>
                    {scanResult.legsList.map((leg,i)=>{
                      const isNet  = leg.startsWith('NET')||leg.startsWith('TOTAL')
                      const isBuy  = leg.startsWith('BUY')
                      const isSell = leg.startsWith('SELL')
                      return (
                        <div key={i} style={{
                          display:'flex',alignItems:'flex-start',gap:8,padding:'6px 9px',borderRadius:3,marginBottom:4,
                          background:isNet?C.bgDeep:isBuy?`${C.green}08`:isSell?`${C.red}08`:'transparent',
                          border:`1px solid ${isNet?C.blue+'40':isBuy?C.green+'30':isSell?C.red+'30':C.border}`,
                        }}>
                          <span style={{fontSize:11,color:isNet?C.blue:isBuy?C.green:isSell?C.red:C.dim,flexShrink:0,width:16}}>
                            {isNet?'$':isBuy?'↑':isSell?'↓':'·'}
                          </span>
                          <span style={{fontSize:12,color:isNet?C.blue:isBuy?C.green:isSell?C.red:C.subtext,fontFamily:'monospace',lineHeight:1.7,wordBreak:'break-all'}}>{leg}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* ── WHY THIS SCORE: chain stats + signals + warnings, collapsed by default ── */}
                <details style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:10,marginBottom:11}}>
                  <summary className="expand-summary" style={{padding:'11px 14px',fontSize:12,fontWeight:600,color:C.text,cursor:'pointer',listStyle:'none'}}>
                    Why this score <span style={{fontSize:11,color:C.subtext,fontWeight:400}}>— chain stats, {scanResult.reasons?.length||0} signal{scanResult.reasons?.length===1?'':'s'}{scanResult.warnings?.length?`, ${scanResult.warnings.length} warning${scanResult.warnings.length===1?'':'s'}`:''}</span>
                    <span className="expand-hint">tap to expand</span>
                  </summary>
                  <div style={{padding:'0 14px 14px'}}>
                    <div className="scanrow" style={{marginBottom:scanResult.reasons?.length||scanResult.warnings?.length?12:0}}>
                      {[
                        {l:'IV',     v:scanResult.iv,     c:C.orange},
                        {l:'DELTA',  v:scanResult.delta,  c:C.text},
                        {l:'THETA',  v:scanResult.theta,  c:C.red},
                        {l:'VOL',    v:scanResult.volume, c:C.dim},
                        {l:'O.I.',   v:scanResult.oi,     c:C.dim},
                        {l:'VOL/AV', v:scanResult.volRatio,c:C.dim},
                      ].map((f,i)=>(
                        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:'6px 8px',boxShadow:C.shadow}}>
                          <div style={{fontSize:12,color:C.dim,letterSpacing:0.5,fontFamily:"'Inter',sans-serif",marginBottom:1}}>{f.l}</div>
                          <div style={{fontSize:13,color:f.c,fontWeight:600}}>{safe(f.v)}</div>
                        </div>
                      ))}
                    </div>
                    {scanResult.reasons?.length>0&&(
                      <div style={{marginBottom:scanResult.warnings?.length?10:0}}>
                        <div style={{fontSize:11,color:C.green,letterSpacing:1,marginBottom:4}}>✅ SIGNALS</div>
                        {scanResult.reasons.map((r,i)=><div key={i} style={{fontSize:11,color:C.subtext,lineHeight:1.7}}>✓ {r}</div>)}
                      </div>
                    )}
                    {scanResult.warnings?.length>0&&(
                      <div>
                        <div style={{fontSize:11,color:C.orange,letterSpacing:1,marginBottom:4}}>⚠️ WARNINGS</div>
                        {scanResult.warnings.map((w,i)=><div key={i} style={{fontSize:11,color:C.subtext,lineHeight:1.7}}>⚠ {w}</div>)}
                      </div>
                    )}
                  </div>
                </details>

                {/* ── CONTEXT: S/R levels + fundamentals + AI brief, collapsed by default ── */}
                {(srLoading || srData || scanResult.sector || scanResult.earningsDate || scanResult.peRatio) && (
                  <details style={{background:C.bgDeep,border:`1px solid ${C.blue}40`,borderRadius:10,marginBottom:11}}>
                    <summary className="expand-summary" style={{padding:'11px 14px',fontSize:12,fontWeight:600,color:C.text,cursor:'pointer',listStyle:'none'}}>
                      Context <span style={{fontSize:11,color:C.subtext,fontWeight:400}}>— support/resistance, fundamentals</span>
                      <span className="expand-hint">tap to expand</span>
                    </summary>
                    <div style={{padding:'0 16px 14px'}}>
                    {srLoading && !srData && (
                      <div style={{fontSize:11,color:C.dim,fontFamily:"'IBM Plex Mono',monospace"}}><span className="pulse">Computing S/R levels (AI commentary above will populate too)...</span></div>
                    )}
                    {srData && (()=>{
                      const price_  = parseFloat(String(scanResult.price||'0').replace('$',''))
                      if (!price_ || isNaN(price_)) return null
                      const range   = (srData.r2 - srData.s2) || 1
                      const pricePct= Math.max(4, Math.min(94, ((price_ - srData.s2) / range) * 88 + 4))
                      const s1Pct   = Math.max(4, Math.min(94, ((srData.s1 - srData.s2) / range) * 88 + 4))
                      const r1Pct   = Math.max(4, Math.min(94, ((srData.r1 - srData.s2) / range) * 88 + 4))
                      return (
                        <>
                          <div style={{position:'relative',height:52,background:C.card,borderRadius:8,marginBottom:10,overflow:'hidden'}}>
                            <div style={{position:'absolute',left:0,top:0,bottom:0,width:s1Pct+'%',background:'rgba(74,222,128,0.08)',borderRight:'1px dashed rgba(74,222,128,0.4)'}}/>
                            <div style={{position:'absolute',right:0,top:0,bottom:0,width:(100-r1Pct)+'%',background:'rgba(248,113,113,0.08)',borderLeft:'1px dashed rgba(248,113,113,0.4)'}}/>
                            <div style={{position:'absolute',top:0,bottom:0,left:pricePct+'%',width:2,background:C.text,borderRadius:1}}/>
                            <div style={{position:'absolute',left:'6px',top:'50%',transform:'translateY(-50%)',fontSize:12,fontFamily:"'IBM Plex Mono',monospace",color:C.green}}>S1 ${srData.s1}</div>
                            <div style={{position:'absolute',left:pricePct+'%',top:'18%',marginLeft:5,fontSize:12,fontFamily:"'IBM Plex Mono',monospace",color:C.text,fontWeight:600,whiteSpace:'nowrap'}}>{scanResult.price}</div>
                            <div style={{position:'absolute',right:'6px',top:'50%',transform:'translateY(-50%)',fontSize:12,fontFamily:"'IBM Plex Mono',monospace",color:C.red}}>R1 ${srData.r1}</div>
                          </div>
                          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'5px 20px',marginBottom:10}}>
                            {[
                              {l:'R2',      v:srData.r2,       c:C.red},
                              {l:'S2',      v:srData.s2,       c:C.green},
                              {l:'R1',      v:srData.r1,       c:C.red},
                              {l:'S1',      v:srData.s1,       c:C.green},
                              {l:'200d MA', v:srData.ma200,    c:C.text},
                              {l:'50d MA',  v:srData.ma50,     c:C.text},
                              {l:'52w High',v:srData.week52High,c:C.red},
                              {l:'52w Low', v:srData.week52Low, c:C.green},
                            ].filter(x=>x.v).map(({l,v,c})=>(
                              <div key={l} style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                                <span style={{fontSize:11,color:C.dim}}>{l}</span>
                                <span style={{fontFamily:"'IBM Plex Mono',monospace",fontWeight:500,fontSize:12,color:c}}>${v}</span>
                              </div>
                            ))}
                          </div>
                          <div style={{fontSize:11,color:C.subtext,lineHeight:1.6,padding:'7px 10px',background:C.card,borderRadius:6,borderLeft:`3px solid ${srData.position==='at_resistance'?C.red:srData.position==='at_support'?C.green:C.blue}`}}>
                            {srData.contextLine}
                          </div>
                        </>
                      )
                    })()}
                    {/* Fundamentals row — sector, market cap, earnings date */}
                    {scanResult && (scanResult.sector || scanResult.earningsDate || scanResult.peRatio) && (
                      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:10,marginBottom:4}}>
                        {scanResult.sector && (
                          <span style={{fontSize:10,padding:'2px 8px',background:C.card,border:`1px solid ${C.border}`,borderRadius:4,color:C.subtext,letterSpacing:0.5}}>
                            {scanResult.sector}
                          </span>
                        )}
                        {scanResult.industry && (
                          <span style={{fontSize:10,padding:'2px 8px',background:C.card,border:`1px solid ${C.border}`,borderRadius:4,color:C.subtext,letterSpacing:0.5}}>
                            {scanResult.industry}
                          </span>
                        )}
                        {scanResult.marketCap && (
                          <span style={{fontSize:10,padding:'2px 8px',background:C.card,border:`1px solid ${C.border}`,borderRadius:4,color:C.blue,letterSpacing:0.5}}>
                            MCap ${(scanResult.marketCap/1e9).toFixed(0)}B
                          </span>
                        )}
                        {scanResult.peRatio && (
                          <span style={{fontSize:10,padding:'2px 8px',background:C.card,border:`1px solid ${C.border}`,borderRadius:4,color:C.subtext,letterSpacing:0.5}}>
                            P/E {parseFloat(scanResult.peRatio).toFixed(1)}
                          </span>
                        )}
                        {scanResult.earningsDate && (() => {
                          const ed = new Date(scanResult.earningsDate)
                          const daysOut = Math.round((ed - new Date()) / (1000*60*60*24))
                          const color = daysOut >= 0 && daysOut <= 7 ? C.red : daysOut <= 21 ? C.orange : C.subtext
                          return (
                            <span style={{fontSize:10,padding:'2px 8px',background:C.card,border:`1px solid ${color}`,borderRadius:4,color,letterSpacing:0.5}}>
                              📅 Earnings {daysOut >= 0 ? `in ${daysOut}d` : `${Math.abs(daysOut)}d ago`}
                            </span>
                          )
                        })()}
                      </div>
                    )}
                    {/* AI brief now shown as its own commentary card right after the trade
                        box (subordinate to the score, not buried here) — see above. */}
                    </div>
                  </details>
                )}
              </div>
            )}
            </>)}

            {scanMode==='auto' && (
            /* ── Auto-scanner section ── */
            <div style={{marginTop:0,paddingTop:0,borderTop:'none'}}>

              {/* Header row */}
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:autoOn?C.green:C.dim,letterSpacing:0.5,fontFamily:"'Inter',sans-serif",display:'flex',alignItems:'center',gap:6}}>
                    <span style={{width:6,height:6,borderRadius:'50%',background:autoOn?C.green:C.dim,display:'inline-block',boxShadow:autoOn?`0 0 8px ${C.green}`:'none'}}/>
                    AUTO-SCANNER {autoOn?'ACTIVE':'— OFF'}
                  </div>
                  <div style={{fontSize:11,color:C.subtext,marginTop:2}}>
                    Every {scanFreq} min · {minScore}%+ conviction · Full S&P 500
                  </div>
                </div>
                <button className="hv" onClick={toggleAuto} style={{
                  background: autoOn ? C.red : C.green, border:'none', color:'#1c1916',
                  fontWeight:700, padding:'8px 18px', borderRadius:4, fontSize:12,
                  letterSpacing:0.3, cursor:'pointer', fontFamily:"'Fraunces',serif",
                }}>{autoOn?'⏹ STOP':'▶ START'}</button>
              </div>

              {/* Filter results by ticker + Frequency */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 140px',gap:8,alignItems:'end',marginBottom:4}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:C.dim,letterSpacing:.5,marginBottom:4,fontFamily:"'Inter',sans-serif"}}>Filter by ticker <span style={{fontWeight:400,color:C.subtext}}>(searches the results below)</span></div>
                  <input value={tickerFilter} onChange={e=>setTickerFilter(e.target.value.toUpperCase())}
                    placeholder="e.g. NVDA"
                    style={{...iSt,width:'100%',boxSizing:'border-box'}}/>
                </div>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:C.dim,letterSpacing:.5,marginBottom:4,fontFamily:"'Inter',sans-serif"}}>Frequency</div>
                  <select value={scanFreq} onChange={e=>{const f=Number(e.target.value);setScanFreq(f);if(autoOn){clearInterval(autoRef.current);autoRef.current=setInterval(runAutoScan,f*60*1000);setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ↺ Interval updated → every ${f} min · ${TF_CONFIG[scanTFRef.current]?.label||scanTFRef.current}`,...p.slice(0,99)])}}} style={iSt}>
                    {[1,2,3,5,10,15,20,30,60].map(v=><option key={v} value={v}>Every {v} {v===1?'min':'mins'}</option>)}
                  </select>
                </div>
              </div>
              {/* Min Edge Score — inline in scanner */}
              <div style={{marginBottom:10}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                  <div style={{fontSize:12,fontWeight:600,color:C.dim,letterSpacing:.5,fontFamily:"'Inter',sans-serif"}}>Min Edge Score</div>
                  <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,color:C.green,fontWeight:700}}>{minScore}%+</span>
                </div>
                <input type="range" min={40} max={95} step={5} value={minScore}
                  onChange={e=>{
                    const v=Number(e.target.value)
                    setMinScore(v)
                    setAlertPrefs(p=>({...p,min_edge_score:v}))
                  }}
                  style={{width:'100%',accentColor:C.green,cursor:'pointer'}}
                />
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:C.dim,marginTop:2}}>
                  <span>40% — more alerts</span><span>95% — high conviction only</span>
                </div>
              </div>

              {/* ── Timeframe filter — all 4 shown mixed by default; click one to narrow ── */}
              <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap',alignItems:'center'}}>
                <span style={{fontSize:11,color:C.dim,fontWeight:600,marginRight:2}}>Showing:</span>
                <button className="hv" onClick={()=>{setAlertTfFilter(null);loadOrRefreshAlerts()}} style={{
                  fontSize:11,fontWeight:600,padding:'4px 11px',borderRadius:14,cursor:'pointer',
                  border:`1px solid ${!alertTfFilter?C.orange:C.border}`,
                  background:!alertTfFilter?`${C.orange}16`:C.card,
                  color:!alertTfFilter?C.orange:C.dim,
                }}>All 4</button>
                {Object.entries(TF_CONFIG).map(([key,cfg])=>(
                  <button key={key} className="hv" onClick={()=>{setAlertTfFilter(key);loadOrRefreshAlerts()}} style={{
                    fontSize:11,fontWeight:600,padding:'4px 11px',borderRadius:14,cursor:'pointer',
                    border:`1px solid ${alertTfFilter===key?cfg.color:C.border}`,
                    background:alertTfFilter===key?`${cfg.color}16`:C.card,
                    color:alertTfFilter===key?cfg.color:C.dim,
                  }}>{cfg.badge} {cfg.label}</button>
                ))}
              </div>

              {/* Alert history — last 10 alerts, clickable for full details */}
              {alertHistory.length>0&&(
                <div style={{marginBottom:10}}>
                  {/* Table header */}
                  <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 10px',marginBottom:3}}>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,width:52}}>SYMBOL</span>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,flex:1}}>CONTRACT</span>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,width:78,textAlign:'center'}}>TIMEFRAME</span>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,width:28}}>DTE</span>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,width:90}}>CONVICTION</span>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,width:28,textAlign:'center'}}>GRADE</span>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:1.5,fontWeight:700,width:40,textAlign:'right'}}>MID</span>
                    <span style={{width:14}}/>
                  </div>
                  {alertHistory.map((al,i)=>({al,i})).filter(({al})=>!tickerFilter || al.ticker?.toUpperCase().includes(tickerFilter)).map(({al,i})=>{
                    const isSelected = selectedAlert===i
                    const scoreCol = al.score>=80?C.green:al.score>=65?C.orange:C.blue
                    const grade = al.score>=80?'A':al.score>=65?'B':'C'
                    return (
                      <div key={i}>
                        {/* Row */}
                        <div className="hv" onClick={()=>{
                          const next = isSelected?null:i
                          setSelectedAlert(next)
                          // Fetch S/R (no AI brief — auto-scanner has no space for it) the first
                          // time this row is expanded; cached in alertSR so re-collapsing/expanding
                          // doesn't re-fetch.
                          if (next!==null && !alertSR[next]) {
                            setAlertSR(p=>({...p,[next]:{loading:true,data:null}}))
                            getAuthToken().then(authTok=>{
                              const headers = authTok ? { Authorization: `Bearer ${authTok}` } : {}
                              // FIX: al.mid and al.chgPct are pre-formatted display strings
                              // ("$1.25", "-5.82%") from loadOrRefreshAlerts/scan_results —
                              // same root cause as the al.iv bug just fixed above. /api/brief
                              // expects raw numbers for price/chgPct (it does its own
                              // parseFloat with a 0 fallback, so this degraded gracefully
                              // rather than crashing, but still sent wrong values). Also
                              // fixed the price-inclusion condition itself, which checked
                              // al.chgPct as a guard for whether to send al.mid — those are
                              // unrelated fields; the real condition is just "do we have a mid".
                              const qp = new URLSearchParams({
                                ticker: al.ticker, skipBrief: '1',
                                price: String(parseFloat(String(al.mid||'').replace(/[^0-9.\-]/g,'')) || ''),
                                chgPct: String(parseFloat(String(al.chgPct||'0').replace(/[^0-9.\-]/g,'')) || 0),
                                iv: String(al.iv||0), dte: String(al.dte||30),
                                score: String(al.score||50), tradeType: al.tradeType||'Call',
                              })
                              return fetch(`/api/brief?${qp}`, { headers }).then(r=>r.json())
                            }).then(d=>{
                              setAlertSR(p=>({...p,[next]:{loading:false,data:d?.sr||null}}))
                            }).catch(()=>{
                              setAlertSR(p=>({...p,[next]:{loading:false,data:null}}))
                            })
                          }
                        }} style={{
                          display:'flex',alignItems:'center',gap:8,
                          padding:'8px 10px',
                          borderRadius:isSelected?'6px 6px 0 0':6,
                          marginBottom:isSelected?0:2,
                          cursor:'pointer',
                          background:isSelected?`${scoreCol}12`:C.bgDeep,
                          border:`1px solid ${isSelected?scoreCol:C.border}`,
                          borderLeft:`3px solid ${scoreCol}`,
                          transition:'all .15s',
                        }}>
                          <span style={{fontFamily:"'Fraunces',serif",fontSize:15,color:scoreCol,letterSpacing:0.3,width:52}}>${al.ticker}</span>
                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,color:C.text,flex:1}}>{al.tradeType} {al.strikeStr}</span>
                          {al.tfLabel&&<span style={{fontSize:10.5,color:al.tfColor,border:`1px solid ${al.tfColor}40`,padding:'1px 6px',borderRadius:2,flexShrink:0,width:78,textAlign:'center',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{al.tfLabel}</span>}
                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:C.dim,width:28}}>{al.dte||'—'}D</span>
                          <div style={{width:90,display:'flex',alignItems:'center',gap:4}}>
                            <div style={{flex:1,height:3,background:C.border,borderRadius:2,overflow:'hidden'}}>
                              <div style={{height:'100%',width:`${al.score||0}%`,background:`linear-gradient(90deg,${scoreCol}80,${scoreCol})`,borderRadius:2}}/>
                            </div>
                            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:scoreCol,fontWeight:700,width:22,textAlign:'right'}}>{al.score}</span>
                          </div>
                          <div style={{width:28,textAlign:'center'}}>
                            <span style={{background:`${scoreCol}20`,border:`1px solid ${scoreCol}50`,borderRadius:3,padding:'1px 5px',color:scoreCol,fontWeight:700,fontSize:12}}>{grade}</span>
                          </div>
                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,color:C.text,width:40,textAlign:'right'}}>{al.mid||'—'}</span>
                          <span style={{fontSize:11,color:C.dim,width:14,textAlign:'center'}}>{isSelected?'▲':'▼'}</span>
                        </div>
                        {/* Expanded detail */}
                        {isSelected&&(
                          <div style={{background:C.bgDeep,border:`1px solid ${scoreCol}40`,borderTop:'none',borderRadius:'0 0 6px 6px',padding:'12px 14px',marginBottom:4}}>
                            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:10}}>
                              {[
                                {l:'ENTRY',  v:al.entry},
                                {l:'TARGET', v:al.target},
                                {l:'STOP',   v:al.stop},
                                {l:'STRIKE', v:al.strikeStr},
                                {l:'EXPIRY', v:al.expiryDisplay||al.expiry||'—'},
                                {l:'IV',     v:al.iv?`${(al.iv*100).toFixed(0)}%`:'—'},
                              ].map(({l,v})=>(
                                <div key={l}>
                                  <div style={{fontSize:11,color:C.dim,letterSpacing:1,marginBottom:3}}>{l}</div>
                                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:C.text,fontWeight:600}}>{v||'—'}</div>
                                </div>
                              ))}
                            </div>
                            {al.tfLabel&&<div style={{fontSize:11,color:C.dim,marginBottom:10,fontFamily:"'IBM Plex Mono',monospace"}}>{al.tfLabel} · {al.alertedAt}</div>}
                            {al.hardBlocks?.length>0&&(
                              <div style={{marginBottom:10}}>
                                {al.hardBlocks.map((b,bi)=>(
                                  <div key={bi} style={{background:C.bgDeep,border:`1px solid ${C.red}60`,borderRadius:5,padding:'8px 12px',marginBottom:5,display:'flex',gap:8,alignItems:'flex-start'}}>
                                    <span style={{fontSize:13,flexShrink:0}}>🚫</span>
                                    <div>
                                      <div style={{fontSize:10,color:C.red,letterSpacing:1.5,marginBottom:2}}>SKIP THIS TRADE</div>
                                      <div style={{fontSize:11,color:C.red,lineHeight:1.5}}>{b}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Why this score — bid/ask/mid/delta/vol/oi/breakeven + reasons + warnings */}
                            {(al.bid||al.ask||al.delta||al.volume||al.oi||al.breakeven||al.reasons?.length>0||al.warnings?.length>0)&&(
                              <details style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,marginBottom:8}}>
                                <summary className="expand-summary" style={{padding:'9px 12px',fontSize:11,fontWeight:600,color:C.text,cursor:'pointer',listStyle:'none'}}>
                                  Why this score <span style={{fontSize:10.5,color:C.subtext,fontWeight:400}}>— chain stats{al.reasons?.length?`, ${al.reasons.length} signal${al.reasons.length===1?'':'s'}`:''}{al.warnings?.length?`, ${al.warnings.length} warning${al.warnings.length===1?'':'s'}`:''}</span>
                                  <span className="expand-hint">tap to expand</span>
                                </summary>
                                <div style={{padding:'0 12px 12px'}}>
                                  <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:al.reasons?.length||al.warnings?.length?8:0}}>
                                    {[
                                      {l:'BID',v:al.bid,c:C.red},{l:'ASK',v:al.ask,c:C.green},{l:'MID',v:al.mid,c:C.blue},
                                      {l:'DELTA',v:al.delta,c:C.text},{l:'VOL',v:al.volume,c:C.dim},{l:'O.I.',v:al.oi,c:C.dim},
                                    ].filter(f=>f.v!=null).map((f,i)=>(
                                      <div key={i} style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:6,padding:'5px 7px'}}>
                                        <div style={{fontSize:9.5,color:C.dim,marginBottom:1}}>{f.l}</div>
                                        <div style={{fontSize:11.5,color:f.c,fontWeight:600}}>{f.v}</div>
                                      </div>
                                    ))}
                                  </div>
                                  {al.breakeven&&(
                                    <div style={{fontSize:11,color:C.subtext,marginBottom:al.reasons?.length||al.warnings?.length?8:0}}>
                                      Break-even ${al.breakeven} {al.breakevenPct&&`(${al.breakevenIsPut?'−':'+'}${Math.abs(parseFloat(al.breakevenPct)).toFixed(1)}%)`}
                                    </div>
                                  )}
                                  {al.reasons?.length>0&&(
                                    <div style={{marginBottom:al.warnings?.length?8:0}}>
                                      <div style={{fontSize:10.5,color:C.green,letterSpacing:1,marginBottom:3}}>✅ SIGNALS</div>
                                      {al.reasons.map((r,ri)=><div key={ri} style={{fontSize:10.5,color:C.subtext,lineHeight:1.6}}>✓ {r}</div>)}
                                    </div>
                                  )}
                                  {al.warnings?.length>0&&(
                                    <div>
                                      <div style={{fontSize:10.5,color:C.orange,letterSpacing:1,marginBottom:3}}>⚠️ WARNINGS</div>
                                      {al.warnings.map((w,wi)=><div key={wi} style={{fontSize:10.5,color:C.subtext,lineHeight:1.6}}>⚠ {w}</div>)}
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}

                            {/* Context — S/R only, fetched on expand. No AI brief (no space in this view). */}
                            {alertSR[i]&&(
                              <details style={{background:C.card,border:`1px solid ${C.blue}30`,borderRadius:8,marginBottom:10}}>
                                <summary className="expand-summary" style={{padding:'9px 12px',fontSize:11,fontWeight:600,color:C.text,cursor:'pointer',listStyle:'none'}}>
                                  Context <span style={{fontSize:10.5,color:C.subtext,fontWeight:400}}>— support/resistance</span>
                                  <span className="expand-hint">tap to expand</span>
                                </summary>
                                <div style={{padding:'0 12px 12px'}}>
                                  {alertSR[i].loading && (
                                    <div style={{fontSize:10.5,color:C.dim,fontFamily:"'IBM Plex Mono',monospace"}}><span className="pulse">Loading S/R…</span></div>
                                  )}
                                  {!alertSR[i].loading && !alertSR[i].data && (
                                    <div style={{fontSize:10.5,color:C.dim}}>S/R unavailable for this ticker right now.</div>
                                  )}
                                  {alertSR[i].data && (
                                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'4px 16px'}}>
                                      {[
                                        {l:'R2',v:alertSR[i].data.r2,c:C.red},{l:'S2',v:alertSR[i].data.s2,c:C.green},
                                        {l:'R1',v:alertSR[i].data.r1,c:C.red},{l:'S1',v:alertSR[i].data.s1,c:C.green},
                                        {l:'200d MA',v:alertSR[i].data.ma200,c:C.text},{l:'50d MA',v:alertSR[i].data.ma50,c:C.text},
                                      ].filter(x=>x.v).map(({l,v,c})=>(
                                        <div key={l} style={{display:'flex',justifyContent:'space-between'}}>
                                          <span style={{fontSize:10.5,color:C.dim}}>{l}</span>
                                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:c}}>${v}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}

                            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                              <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildScanAlert(al, true));setAlertCopied(true);setTimeout(()=>setAlertCopied(false),2000)}} style={{
                                background:`${C.green}18`,border:`1px solid ${C.green}40`,color:C.green,
                                padding:'6px 12px',borderRadius:4,fontSize:11,cursor:'pointer',fontWeight:700,letterSpacing:0.5
                              }}>{alertCopied?'✅ COPIED':'📋 COPY'}</button>
                              <button className="hv" onClick={()=>pushToJournal(al)} style={{
                                background:`${C.orange}18`,border:`1px solid ${C.orange}40`,color:C.orange,
                                padding:'6px 12px',borderRadius:4,fontSize:11,cursor:'pointer',fontWeight:700,letterSpacing:0.5
                              }}>📋 PAPER TRADE</button>
                              <TweetShare result={al} isAdmin={isAdmin} getToken={getAuthToken} C={C} />
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Scanner log */}
              {autoLog.length>0&&(
                <div style={{background:C.bgDeep,borderRadius:8,padding:9,maxHeight:140,overflowY:'auto',border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:11,letterSpacing:1.5,color:C.dim,marginBottom:5,fontWeight:600}}>SCAN LOG</div>
                  {autoLog.map((l,i)=>(
                    <div key={i} style={{
                      fontSize:11,
                      color:l.includes('🚀')?C.green:l.includes('❌')?C.red:l.includes('▶')||l.includes('◼')||l.includes('↺')?C.blue:C.subtext,
                      fontFamily:'monospace',lineHeight:1.7,
                      fontWeight:l.includes('🚀')?600:400,
                    }}>{l}</div>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        )}

                {/* journal tab removed — see /app/trades */}

      </div>

      {/* backtest tab removed — see /app/trades */}
      {false /*placeholder - content removed*/ && (
        <div className="si">
          {(()=>{
            const all   = trades
            const closed= all.filter(t=>t.status!=='Open')
            const wins  = closed.filter(t=>parseFloat(t.pnl||0)>0)
            const losses= closed.filter(t=>parseFloat(t.pnl||0)<0)
            const open  = all.filter(t=>t.status==='Open')

            // Filter helpers
            const hasConv   = t=>t.conviction&&!isNaN(parseFloat(t.conviction))
            const conv      = t=>parseFloat(t.conviction||0)
            const ivAt      = t=>parseFloat(t.iv||0)
            const chgAt     = t=>parseFloat(t.chgPctAtEntry||0)
            const beReq     = t=>Math.abs(parseFloat(t.breakevenReqPct||0))  // abs: puts now store negative %, magnitude is what matters for difficulty buckets
            const pnl       = t=>parseFloat(t.pnl||0)
            const hb        = t=>parseInt(t.hardBlockCount||0)

            // conviction bands
            const hi90  = closed.filter(t=>hasConv(t)&&conv(t)>=90)
            const hi70  = closed.filter(t=>hasConv(t)&&conv(t)>=70&&conv(t)<90)
            const lo70  = closed.filter(t=>hasConv(t)&&conv(t)<70)

            const wr    = arr=>arr.length?Math.round(arr.filter(t=>pnl(t)>0).length/arr.length*100):null
            const avgPL = arr=>arr.length?arr.reduce((s,t)=>s+pnl(t),0)/arr.length:0
            const totPL = arr=>arr.reduce((s,t)=>s+pnl(t),0)

            // Would-have-been-blocked analysis
            const wouldBlock= t=> ivAt(t)>55 || Math.abs(chgAt(t))>2.0 || hb(t)>0
            const blocked   = closed.filter(t=>hasConv(t)&&wouldBlock(t))
            const passed    = closed.filter(t=>hasConv(t)&&!wouldBlock(t))
            const blockedWr = wr(blocked)
            const passedWr  = wr(passed)

            // Filtered display list
            const displayList = btFilter==='90plus'   ? closed.filter(t=>conv(t)>=90)
                               : btFilter==='blocked'  ? closed.filter(wouldBlock)
                               : btFilter==='passed'   ? closed.filter(t=>!wouldBlock(t)&&hasConv(t))
                               : btFilter==='open'     ? open
                               : closed

            // P&L equity curve data
            const curve = [...closed].reverse()
            const cumPnL = curve.reduce((acc,t)=>{
              acc.push({y:(acc[acc.length-1]?.y||0)+pnl(t), t:t.ticker})
              return acc
            },[])

            return (
              <div>
                {/* ── Header ── */}
                <div style={{marginBottom:14}}>
                  <div style={{fontFamily:"'Fraunces',serif",fontSize:22,color:C.text,letterSpacing:0.3,lineHeight:1}}>STRATEGY BACKTEST</div>
                  <div style={{fontSize:12,color:C.dim,marginTop:2}}>Based on trades logged in your Journal · tap 📋 PAPER TRADE on any scan result to track it here</div>
                </div>

                {closed.length===0 ? (
                  <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:6,padding:24,textAlign:'center'}}>
                    <div style={{fontSize:13,color:C.dim,marginBottom:8}}>No closed trades yet</div>
                    <div style={{fontSize:11,color:C.subtext,lineHeight:1.8}}>
                      Two ways to build your track record:<br/>
                      <span style={{color:C.orange}}>①</span> Tap <strong style={{color:C.orange}}>📋 PAPER TRADE</strong> on any scan result — logs it instantly<br/>
                      <span style={{color:C.green}}>②</span> Use <strong style={{color:C.green}}>+ LOG TRADE</strong> in the Journal tab to enter past trades manually
                    </div>
                  </div>
                ) : (
                  <>
                    {/* ── Summary stat row ── */}
                    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:14}}>
                      {[
                        {l:'TOTAL P&L',  v:(totPL(closed)>=0?'+':'')+`$${Math.abs(totPL(closed)).toFixed(0)}`, c:totPL(closed)>=0?C.green:C.red},
                        {l:'WIN RATE',   v:wr(closed)+'%', c:wr(closed)>=60?C.green:wr(closed)>=45?C.orange:C.red},
                        {l:'TRADES',     v:`${wins.length}W / ${losses.length}L`, c:C.dim},
                        {l:'AVG WIN',    v:'+$'+wins.length?Math.abs(avgPL(wins)).toFixed(0):'—', c:C.green},
                        {l:'AVG LOSS',   v:'-$'+losses.length?Math.abs(avgPL(losses)).toFixed(0):'—', c:C.red},
                        {l:'EXPECTANCY', v:(()=>{
                          const w=wr(closed)/100, l=1-w
                          const aw=wins.length?Math.abs(avgPL(wins)):0
                          const al=losses.length?Math.abs(avgPL(losses)):1
                          return ((w*aw - l*al)).toFixed(0)
                        })(), c:(()=>{const w=wr(closed)/100,l=1-w,aw=wins.length?Math.abs(avgPL(wins)):0,al=losses.length?Math.abs(avgPL(losses)):1;return w*aw-l*al>=0?C.green:C.red})()},
                      ].map((s,i)=>(
                        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'10px 12px'}}>
                          <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{s.l}</div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:19,color:s.c}}>{s.v}</div>
                        </div>
                      ))}
                    </div>

                    {/* ── Filter impact: blocked vs passed ── */}
                    {(blocked.length>0||passed.length>0)&&(
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:14}}>
                        <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:10}}>NEW FILTER IMPACT ANALYSIS</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                          <div style={{background:isDark?'#100205':'#fff0f2',border:`1px solid ${C.red}40`,borderRadius:5,padding:'10px 12px'}}>
                            <div style={{fontSize:11,color:C.red,letterSpacing:1.5,marginBottom:4}}>🚫 WOULD HAVE BLOCKED</div>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:28,color:C.red}}>{blocked.length}</div>
                            <div style={{fontSize:12,color:C.dim,marginTop:2}}>trades match skip criteria</div>
                            {blockedWr!==null&&<div style={{fontSize:11,color:C.red,marginTop:4}}>Actual win rate: <strong>{blockedWr}%</strong></div>}
                            <div style={{fontSize:11,color:C.dim,marginTop:1}}>P&L if skipped: <span style={{color:totPL(blocked)<=0?C.green:C.red}}>{totPL(blocked)<=0?'Saved':'Lost'} ${Math.abs(totPL(blocked)).toFixed(0)}</span></div>
                          </div>
                          <div style={{background:isDark?'#020e06':'#f0fff4',border:`1px solid ${C.green}40`,borderRadius:5,padding:'10px 12px'}}>
                            <div style={{fontSize:11,color:C.green,letterSpacing:1.5,marginBottom:4}}>✅ PASSES ALL FILTERS</div>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:28,color:C.green}}>{passed.length}</div>
                            <div style={{fontSize:12,color:C.dim,marginTop:2}}>clean setups</div>
                            {passedWr!==null&&<div style={{fontSize:11,color:C.green,marginTop:4}}>Win rate: <strong>{passedWr}%</strong></div>}
                            <div style={{fontSize:11,color:C.dim,marginTop:1}}>P&L: <span style={{color:totPL(passed)>=0?C.green:C.red}}>${totPL(passed).toFixed(0)}</span></div>
                          </div>
                        </div>
                        {blocked.length>0&&(
                          <div style={{fontSize:11,color:C.dim,lineHeight:1.8}}>
                            <strong style={{color:C.orange}}>What triggered the blocks:</strong>{' '}
                            {blocked.filter(t=>ivAt(t)>55).length>0&&<span style={{color:C.orange}}>High IV ({blocked.filter(t=>ivAt(t)>55).length})</span>}
                            {blocked.filter(t=>Math.abs(chgAt(t))>2).length>0&&<span style={{color:C.orange}}> · Chasing ({blocked.filter(t=>Math.abs(chgAt(t))>2).length})</span>}
                            {blocked.filter(t=>hb(t)>0&&ivAt(t)<=55&&Math.abs(chgAt(t))<=2).length>0&&<span style={{color:C.orange}}> · Other flags ({blocked.filter(t=>hb(t)>0&&ivAt(t)<=55&&Math.abs(chgAt(t))<=2).length})</span>}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Conviction band breakdown ── */}
                    {(hi90.length>0||hi70.length>0||lo70.length>0)&&(
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:14}}>
                        <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:10}}>WIN RATE BY CONVICTION BAND</div>
                        {[
                          {label:'90%+  HIGH CONVICTION', arr:hi90, color:C.green},
                          {label:'70–89%  MODERATE',      arr:hi70, color:C.orange},
                          {label:'<70%   LOW',             arr:lo70, color:C.red},
                        ].filter(b=>b.arr.length>0).map((b,i)=>{
                          const bWr=wr(b.arr)
                          const bPL=totPL(b.arr)
                          const w=b.arr.filter(t=>pnl(t)>0).length
                          return (
                            <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:4,marginBottom:5,background:isDark?'#04080e':'#f5f7fa',border:`1px solid ${b.color}30`}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:11,color:b.color,letterSpacing:1,marginBottom:2}}>{b.label}</div>
                                <div style={{display:'flex',gap:12,fontSize:12,color:C.dim}}>
                                  <span>{b.arr.length} trades · {w}W/{b.arr.length-w}L</span>
                                  <span style={{color:bPL>=0?C.green:C.red}}>{bPL>=0?'+':''}{bPL.toFixed(0)} P&L</span>
                                </div>
                              </div>
                              <div style={{textAlign:'right'}}>
                                <div style={{fontFamily:"'Fraunces',serif",fontSize:24,color:bWr>=60?C.green:bWr>=45?C.orange:C.red,lineHeight:1}}>{bWr}%</div>
                                <div style={{fontSize:11,color:C.dim}}>win rate</div>
                              </div>
                              <div style={{width:50,height:6,background:C.border,borderRadius:3,overflow:'hidden'}}>
                                <div style={{width:(bWr||0)+'%',height:'100%',background:b.color,borderRadius:3}}/>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* ── P&L by IV level ── */}
                    {closed.filter(t=>ivAt(t)>0).length>=2&&(
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:14}}>
                        <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:10}}>OUTCOME BY IV AT ENTRY</div>
                        {[
                          {label:'Low IV  (<40%)',    arr:closed.filter(t=>ivAt(t)>0&&ivAt(t)<40),   color:C.green},
                          {label:'Moderate IV  (40–55%)', arr:closed.filter(t=>ivAt(t)>=40&&ivAt(t)<=55), color:C.orange},
                          {label:'High IV  (>55%)',   arr:closed.filter(t=>ivAt(t)>55),              color:C.red},
                        ].filter(b=>b.arr.length>0).map((b,i)=>{
                          const bWr=wr(b.arr), bPL=totPL(b.arr), w=b.arr.filter(t=>pnl(t)>0).length
                          return (
                            <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:4,marginBottom:5,background:isDark?'#04080e':'#f5f7fa',border:`1px solid ${b.color}30`}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:11,color:b.color,letterSpacing:1,marginBottom:2}}>{b.label}</div>
                                <div style={{fontSize:12,color:C.dim}}>{b.arr.length} trades · {w}W/{b.arr.length-w}L · <span style={{color:bPL>=0?C.green:C.red}}>{bPL>=0?'+':''}{bPL.toFixed(0)}</span></div>
                              </div>
                              <div style={{fontFamily:"'Fraunces',serif",fontSize:22,color:bWr>=60?C.green:bWr>=45?C.orange:C.red}}>{bWr}%</div>
                            </div>
                          )
                        })}
                        <div style={{fontSize:11,color:C.subtext,marginTop:6,lineHeight:1.8}}>
                          MSTR lesson: buying high IV (66%) loses even when direction is right, because IV crush overwhelms the premium gain.
                        </div>
                      </div>
                    )}

                    {/* ── Break-even analysis ── */}
                    {closed.filter(t=>beReq(t)>0).length>=2&&(
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:14}}>
                        <div style={{fontSize:11,color:C.dim,letterSpacing:2,marginBottom:10}}>WIN RATE BY BREAK-EVEN MOVE REQUIRED</div>
                        {[
                          {label:'Easy  (<3% move needed)',   arr:closed.filter(t=>beReq(t)>0&&beReq(t)<3),  color:C.green},
                          {label:'Moderate  (3–5% needed)',   arr:closed.filter(t=>beReq(t)>=3&&beReq(t)<=5),color:C.orange},
                          {label:'Hard  (>5% move needed)',   arr:closed.filter(t=>beReq(t)>5),              color:C.red},
                        ].filter(b=>b.arr.length>0).map((b,i)=>{
                          const bWr=wr(b.arr), w=b.arr.filter(t=>pnl(t)>0).length
                          return (
                            <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:4,marginBottom:5,background:isDark?'#04080e':'#f5f7fa',border:`1px solid ${b.color}30`}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:11,color:b.color,letterSpacing:1,marginBottom:2}}>{b.label}</div>
                                <div style={{fontSize:12,color:C.dim}}>{b.arr.length} trades · {w}W/{b.arr.length-w}L</div>
                              </div>
                              <div style={{fontFamily:"'Fraunces',serif",fontSize:22,color:bWr>=60?C.green:bWr>=45?C.orange:C.red}}>{bWr}%</div>
                            </div>
                          )
                        })}
                        <div style={{fontSize:11,color:C.subtext,marginTop:6,lineHeight:1.8}}>
                          GOOGL needed +4.3% — historically that puts you in the bottom 30% of probability outcomes. Sticking to trades requiring {'<'}3% move improves win rate dramatically.
                        </div>
                      </div>
                    )}

                    {/* ── Trade list with filter ── */}
                    <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:10}}>
                      {[
                        {id:'all',     l:'All Closed'},
                        {id:'90plus',  l:'90%+ Only'},
                        {id:'blocked', l:'Would Block'},
                        {id:'passed',  l:'Clean Setups'},
                        {id:'open',    l:'Open / Paper'},
                      ].map(f=>(
                        <button key={f.id} className="hv" onClick={()=>setBtFilter(f.id)} style={{
                          padding:'5px 10px',borderRadius:3,fontSize:12,letterSpacing:.5,cursor:'pointer',
                          border:`1px solid ${btFilter===f.id?C.green:C.border}`,
                          color:btFilter===f.id?C.green:C.dim,
                          background:btFilter===f.id?`${C.green}15`:'transparent',
                        }}>{f.l} ({f.id==='all'?closed.length:f.id==='90plus'?closed.filter(t=>conv(t)>=90).length:f.id==='blocked'?blocked.length:f.id==='passed'?passed.length:open.length})</button>
                      ))}
                    </div>

                    {displayList.length===0
                      ? <div style={{fontSize:11,color:C.dim,textAlign:'center',padding:16,border:`1px dashed ${C.border}`,borderRadius:5}}>No trades in this filter</div>
                      : displayList.map((t,i)=>{
                          const p=pnl(t), isWin=p>0, isLoss=p<0
                          const stC=t.status==='Open'?C.blue:isWin?C.green:isLoss?C.red:C.dim
                          const blocked_=wouldBlock(t)
                          return (
                            <div key={t.id||i} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${stC}`,borderRadius:4,padding:'10px 13px',marginBottom:6}}>
                              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:4}}>
                                <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                                  <span style={{fontFamily:"'Fraunces',serif",fontSize:18,color:C.text,letterSpacing:0.3}}>{t.ticker}</span>
                                  <span style={{fontSize:11,color:stC,border:`1px solid ${stC}40`,padding:'1px 5px',borderRadius:2}}>{t.status}</span>
                                  <span style={{fontSize:12,color:C.dim}}>{t.type}</span>
                                  {t.strike&&<span style={{fontSize:12,color:C.dim}}>{t.strike}</span>}
                                  {t.expiry&&<span style={{fontSize:11,color:C.dim}}>{t.expiry}</span>}
                                  {t.conviction&&<span style={{fontSize:11,color:C.blue,border:`1px solid ${C.blue}30`,padding:'1px 5px',borderRadius:2}}>{t.conviction}%</span>}
                                  {blocked_&&<span style={{fontSize:11,color:C.red,border:`1px solid ${C.red}40`,padding:'1px 5px',borderRadius:2}}>🚫 BLOCKED</span>}
                                </div>
                                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                                  {p!==0&&<span style={{fontFamily:"'Fraunces',serif",fontSize:18,color:isWin?C.green:C.red}}>{p>=0?'+':'-'}${Math.abs(p).toFixed(0)}</span>}
                                  {t.status==='Open'&&<span style={{fontSize:11,color:C.orange,border:`1px solid ${C.orange}40`,padding:'1px 5px',borderRadius:2}}>PAPER</span>}
                                </div>
                              </div>
                              <div style={{display:'flex',gap:10,marginTop:5,fontSize:12,color:C.dim,flexWrap:'wrap'}}>
                                {t.entry&&<span>Entry: <span style={{color:C.subtext}}>{t.entry}</span></span>}
                                {t.exitPrice&&<span>Exit: <span style={{color:C.subtext}}>{t.exitPrice}</span></span>}
                                {t.iv&&<span>IV: <span style={{color:parseFloat(t.iv)>55?C.red:parseFloat(t.iv)>40?C.orange:C.green}}>{t.iv}%</span></span>}
                                {t.chgPctAtEntry&&<span>Stk Δ: <span style={{color:Math.abs(parseFloat(t.chgPctAtEntry))>2?C.red:C.subtext}}>{t.chgPctAtEntry}%</span></span>}
                                {t.breakevenReqPct&&<span>BE req: <span style={{color:Math.abs(parseFloat(t.breakevenReqPct))>5?C.red:Math.abs(parseFloat(t.breakevenReqPct))>3?C.orange:C.green}}>{parseFloat(t.breakevenReqPct)<0?'−':'+'}{Math.abs(parseFloat(t.breakevenReqPct)).toFixed(1)}%</span></span>}
                              </div>
                              {t.notes&&<div style={{marginTop:4,fontSize:12,color:C.subtext,lineHeight:1.5}}>{t.notes}</div>}
                            </div>
                          )
                        })
                    }
                  </>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── Toast notification ── */}
      {paperToast&&(
        <div style={{
          position:'fixed',top:72,left:'50%',transform:'translateX(-50%)',zIndex:999,
          background:C.green,color:'#1c1916',borderRadius:5,
          padding:'9px 18px',fontSize:11,fontWeight:600,letterSpacing:.5,
          boxShadow:`0 4px 20px ${C.green}66`,
          animation:'toastIn .2s ease',whiteSpace:'nowrap',
        }}>{paperToast}</div>
      )}


      {/* ═══════════════ TOOLS / SETTINGS SLIDE-IN PANEL ════════════════════ */}
      {showTools&&(
        <div style={{position:'fixed',inset:0,zIndex:200}}>
          {/* Backdrop */}
          <div onClick={()=>setShowTools(false)} style={{position:'absolute',inset:0,background:'rgba(0,0,0,.65)'}}/>
          {/* Panel */}
          <div style={{
            position:'absolute',right:0,top:0,bottom:0,
            width:'min(520px,100vw)',
            background:C.bg,borderLeft:`1px solid ${C.border}`,transition:'background .25s',
            display:'flex',flexDirection:'column',
            animation:'slideIn .22s ease',
            boxShadow:'-8px 0 32px rgba(0,0,0,.2)',
          }}>
            <style>{`@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>

            {/* Panel header */}
            <div style={{padding:'16px 20px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',background:C.bgAlt,flexShrink:0}}>
              <span style={{fontFamily:"'Fraunces',serif",fontSize:18,letterSpacing:0.3,color:C.green}}>TOOLS</span>
              <button className="hv" onClick={()=>setShowTools(false)} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'4px 10px',borderRadius:3,fontSize:11,cursor:'pointer'}}>✕ CLOSE</button>
            </div>

            {/* Panel sub-tabs */}
            <div style={{display:'flex',gap:4,padding:'8px 12px',borderBottom:`1px solid ${C.border}`,flexWrap:'wrap',flexShrink:0,background:C.panel}}>
              {[
                {id:'settings',  l:'Settings'},
                {id:'checklist', l:'Checklist'},
                {id:'strategy',  l:'Strategy'},
                {id:'exit',      l:'Exit Rules'},
                {id:'futures',   l:'Futures'},
              ].map(t=>(
                <button key={t.id} onClick={()=>setToolsTab(t.id)} style={{
                  padding:'6px 16px',borderRadius:6,fontSize:11,letterSpacing:0,cursor:'pointer',
                  fontFamily:"'Inter',sans-serif",fontWeight:600,
                  border:`1px solid ${toolsTab===t.id?C.green:C.border}`,
                  color:toolsTab===t.id?C.green:C.dim,
                  background:toolsTab===t.id?`${C.green}15`:'transparent',
                }}>{t.l}</button>
              ))}
            </div>

            {/* Panel content scroll */}
            <div style={{overflowY:'auto',flex:1,padding:'14px 16px'}}>

              {/* ── SETTINGS ── */}
              {toolsTab==='settings'&&(
                <div className="si">

                  {/* ═══════════════════════════════════════════════
                      ADMIN-ONLY SECTION
                  ═══════════════════════════════════════════════ */}
                  {isAdmin&&(<>

                    {/* Feedback Viewer */}
                    <Card C={C} style={{marginBottom:12}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                        <Lbl C={C} color={C.purple}>💬 USER FEEDBACK</Lbl>
                        <button className="hv" onClick={loadAdminFeedback} disabled={adminFbLoading} style={{
                          background:`${C.purple}18`,border:`1px solid ${C.purple}40`,color:C.purple,
                          padding:'4px 12px',borderRadius:4,fontSize:11,cursor:'pointer',letterSpacing:.5
                        }}>{adminFbLoading?'Loading…':'↺ LOAD'}</button>
                      </div>
                      {adminFbErr&&(
                        <div style={{fontSize:11,color:C.red,background:`${C.red}12`,border:`1px solid ${C.red}30`,borderRadius:4,padding:'8px 10px',marginBottom:8}}>
                          Error: {adminFbErr}
                        </div>
                      )}
                      {adminFeedback.length===0&&!adminFbLoading&&!adminFbErr&&(
                        <div style={{fontSize:12,color:C.dim,textAlign:'center',padding:'12px 0'}}>Click LOAD to fetch feedback</div>
                      )}
                      {adminFeedback.length===0&&!adminFbLoading&&!adminFbErr&&adminFeedback!==null&&(
                        <div style={{display:'none'}}/>
                      )}
                      {adminFeedback.map((fb,i)=>(
                        <div key={i} style={{
                          background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:6,
                          padding:'10px 12px',marginBottom:8
                        }}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5,flexWrap:'wrap',gap:4}}>
                            <span style={{
                              fontSize:10,fontWeight:700,letterSpacing:.5,
                              color:fb.type==='bug'?C.red:fb.type==='praise'?C.green:C.purple,
                              background:fb.type==='bug'?`${C.red}15`:fb.type==='praise'?`${C.green}15`:`${C.purple}15`,
                              border:`1px solid ${fb.type==='bug'?C.red:fb.type==='praise'?C.green:C.purple}40`,
                              padding:'2px 7px',borderRadius:3,fontFamily:"'IBM Plex Mono',monospace"
                            }}>{fb.type?.toUpperCase()}</span>
                            <span style={{fontSize:10,color:C.dim,fontFamily:"'IBM Plex Mono',monospace"}}>
                              {fb.email||'anonymous'} · {fb.created_at?new Date(fb.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}
                            </span>
                          </div>
                          <div style={{fontSize:12,color:C.text,lineHeight:1.5}}>{fb.message}</div>
                        </div>
                      ))}
                    </Card>

                    {/* Telegram Bot */}
                    <Card C={C} style={{marginBottom:12}}>
                      <Lbl C={C} color={C.blue}>📱 TELEGRAM BOT</Lbl>
                      <div style={{display:'grid',gap:8,marginBottom:10}}>
                        <Field C={C} label="Bot Token" value={tgToken} onChange={setTgToken} placeholder="7123456789:AAFxxx" type="password"/>
                        <Field C={C} label="Chat ID or @ChannelName" value={tgChatId} onChange={setTgChatId} placeholder="-1001234567890"/>
                      </div>
                      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                        <button className="hv" onClick={saveTgPrefs} disabled={tgSaving||!tgToken||!tgChatId} style={{
                          background:tgToken&&tgChatId?C.green:'transparent',
                          border:`1px solid ${tgToken&&tgChatId?C.green:C.border}`,
                          color:tgToken&&tgChatId?'#000':C.dim,
                          padding:'7px 16px',borderRadius:4,fontSize:12,fontWeight:700,letterSpacing:.8,
                          cursor:tgToken&&tgChatId?'pointer':'not-allowed'
                        }}>{tgSaving?'SAVING...':'SAVE'}</button>
                        <button className="hv" onClick={async()=>{
                          setTgStatus('sending...')
                          const authTok=await getAuthToken().catch(()=>null)
                          const r=await sendTelegram(`🤖 *OPTIONS EDGE*\n\nAdmin connected · Alerts active at ${minScore}%+ conviction.\n\n_${new Date().toLocaleString()}_`,tgToken,tgChatId,authTok)
                          setTgStatus(r.ok?'✅ Sent!':'❌ Failed: '+(r.description||r.error||'check token'))
                          setTimeout(()=>setTgStatus(''),5000)
                        }} disabled={!tgToken||!tgChatId} style={{
                          background:tgToken&&tgChatId?`${C.blue}20`:'transparent',
                          border:`1px solid ${tgToken&&tgChatId?C.blue:C.border}`,
                          color:tgToken&&tgChatId?C.blue:C.dim,
                          padding:'7px 16px',borderRadius:4,fontSize:12,letterSpacing:.8,
                          cursor:tgToken&&tgChatId?'pointer':'not-allowed'
                        }}>TEST</button>
                        {tgSaveStatus==='saved'&&<span style={{fontSize:11,color:C.green}}>Saved</span>}
                        {tgSaveStatus.startsWith('error')&&<span style={{fontSize:11,color:C.red}}>{tgSaveStatus.slice(6)}</span>}
                        {tgStatus&&<span style={{fontSize:11,color:tgStatus.startsWith('✅')?C.green:C.red}}>{tgStatus}</span>}
                      </div>
                    </Card>

                  </>)}

                  {/* ═══════════════════════════════════════════════
                      ALL USERS
                  ═══════════════════════════════════════════════ */}

                  {/* Alert Preferences */}
                  <Card C={C} style={{marginBottom:12}}>
                    <Lbl C={C} color={C.green}>🔔 ALERT PREFERENCES</Lbl>

                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:alertPrefs.email_alerts?10:14}}>
                      <span style={{fontSize:11,color:C.text,fontWeight:600}}>Email Alerts</span>
                      <button className="hv" onClick={()=>setAlertPrefs(p=>({...p,email_alerts:!p.email_alerts}))} style={{
                        width:38,height:20,borderRadius:10,border:'none',cursor:'pointer',
                        background:alertPrefs.email_alerts?C.green:'#1a2e3e',
                        position:'relative',transition:'background .2s',flexShrink:0,
                      }}>
                        <span style={{position:'absolute',top:2,left:alertPrefs.email_alerts?20:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left .2s'}}/>
                      </button>
                    </div>
                    {alertPrefs.email_alerts&&(
                      <div style={{marginBottom:14}}>
                        <Field C={C} label="Alert Email" value={alertPrefs.alert_email}
                          onChange={v=>setAlertPrefs(p=>({...p,alert_email:v}))}
                          placeholder={userEmail||'you@example.com'}/>
                      </div>
                    )}

                    {/* Schedule info */}
                    <div style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:6,padding:'10px 12px',marginBottom:14,display:'flex',gap:10,alignItems:'flex-start'}}>
                      <span style={{fontSize:14,flexShrink:0,marginTop:1}}>📬</span>
                      <div>
                        <div style={{fontSize:12,color:C.text,fontWeight:600,marginBottom:3}}>Sent once daily at 10 AM ET, Mon–Fri</div>
                        <div style={{fontSize:12,color:C.dim,lineHeight:1.6}}>You'll only receive an email when high-conviction setups exist. No email means no strong setups today — that's normal.</div>
                      </div>
                    </div>

                    <div style={{marginBottom:14}}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                        <span style={{fontSize:11,color:C.text,fontWeight:600}}>Min Edge Score</span>
                        <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:C.green}}>{alertPrefs.min_edge_score}%</span>
                      </div>
                      <input type="range" min={40} max={95} step={5}
                        value={alertPrefs.min_edge_score}
                        onChange={e=>setAlertPrefs(p=>({...p,min_edge_score:Number(e.target.value)}))}
                        style={{width:'100%',accentColor:C.green,cursor:'pointer'}}
                      />
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:C.dim,marginTop:2}}>
                        <span>40% — more alerts</span><span>95% — high conviction only</span>
                      </div>
                    </div>

                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:11,color:C.text,fontWeight:600,marginBottom:8}}>
                        Watch Symbols <span style={{color:C.dim,fontWeight:400}}>({alertPrefs.symbols.length}/10)</span>
                      </div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:8}}>
                        {PRESET_SYMS.map(s=>{
                          const on=alertPrefs.symbols.includes(s)
                          return <button key={s} className="hv" onClick={()=>toggleAlertSym(s)} style={{
                            padding:'4px 10px',borderRadius:4,fontSize:12,cursor:'pointer',fontWeight:700,letterSpacing:.5,
                            background:on?`${C.green}20`:'transparent',
                            border:`1px solid ${on?C.green:C.border}`,
                            color:on?C.green:C.dim,
                          }}>{s}</button>
                        })}
                      </div>
                      {alertPrefs.symbols.filter(s=>!PRESET_SYMS.includes(s)).map(s=>(
                        <span key={s} style={{display:'inline-flex',alignItems:'center',gap:4,padding:'4px 10px',borderRadius:4,
                          fontSize:12,background:`${C.orange}18`,border:`1px solid ${C.orange}40`,color:C.orange,marginRight:6,marginBottom:6}}>
                          {s}
                          <button className="hv" onClick={()=>setAlertPrefs(p=>({...p,symbols:p.symbols.filter(x=>x!==s)}))}
                            style={{background:'transparent',border:'none',color:C.orange,cursor:'pointer',padding:0,fontSize:11,lineHeight:1}}>✕</button>
                        </span>
                      ))}
                      <div style={{display:'flex',gap:6,marginTop:4}}>
                        <input value={customSymInput} onChange={e=>setCustomSymInput(e.target.value.toUpperCase())}
                          onKeyDown={e=>e.key==='Enter'&&addCustomSym()}
                          placeholder="Add ticker…" maxLength={8}
                          style={{flex:1,background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:4,
                            color:C.text,fontSize:12,padding:'5px 8px',fontFamily:"'IBM Plex Mono',monospace",outline:'none'}}/>
                        <button className="hv" onClick={addCustomSym}
                          style={{background:`${C.green}20`,border:`1px solid ${C.green}40`,color:C.green,
                            padding:'5px 12px',borderRadius:4,fontSize:12,cursor:'pointer'}}>ADD</button>
                      </div>
                    </div>

                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <button className="hv" onClick={saveAlertPrefs} disabled={alertPrefsSaving} style={{
                        background:alertPrefsSaving?'transparent':C.green,
                        border:`1px solid ${alertPrefsSaving?C.border:C.green}`,
                        color:alertPrefsSaving?C.dim:'#000',fontWeight:700,
                        padding:'7px 18px',borderRadius:4,fontSize:12,letterSpacing:.8,
                        cursor:alertPrefsSaving?'not-allowed':'pointer',
                      }}>{alertPrefsSaving?'SAVING…':'SAVE PREFERENCES'}</button>
                      {alertPrefsSaved&&<span style={{fontSize:11,color:C.green}}>✓ Saved</span>}
                      {alertPrefsErr&&<span style={{fontSize:11,color:C.red}}>{alertPrefsErr}</span>}
                    </div>
                  </Card>

                                    {/* Display */}
                  <Card C={C} style={{marginBottom:12}}>
                    <Lbl C={C} color={C.dim}>🎨 DISPLAY</Lbl>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                      <div>
                        <div style={{fontSize:11,color:C.text,fontWeight:600}}>Theme</div>
                        <div style={{fontSize:12,color:C.dim,marginTop:2}}>{isDark?'Dark mode active':'Light mode active'}</div>
                      </div>
                      <button className="hv" onClick={()=>setIsDark(p=>!p)} style={{
                        width:38,height:20,borderRadius:10,border:'none',cursor:'pointer',
                        background:isDark?C.green:'#1a2e3e',position:'relative',transition:'background .2s',flexShrink:0,
                      }}>
                        <span style={{position:'absolute',top:2,left:isDark?20:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left .2s'}}/>
                      </button>
                    </div>
                  </Card>

                  {/* Feedback */}
                  <Card C={C} style={{marginBottom:12}}>
                    <Lbl C={C} color={C.purple}>💬 SHARE FEEDBACK</Lbl>
                    <div style={{fontSize:12,color:C.dim,marginBottom:12,lineHeight:1.5}}>
                      Help us improve OptionsEdgeFlow. Bug reports, feature ideas, or just tell us what you love.
                    </div>
                    <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
                      {[['suggestion','💡 Suggestion'],['bug','🐛 Bug Report'],['praise','⭐ Praise'],['other','💬 Other']].map(([v,l])=>(
                        <button key={v} className="hv" onClick={()=>setFeedbackType(v)} style={{
                          padding:'5px 12px',borderRadius:4,fontSize:11,cursor:'pointer',fontWeight:600,
                          background:feedbackType===v?`${C.purple}20`:'transparent',
                          border:`1px solid ${feedbackType===v?C.purple:C.border}`,
                          color:feedbackType===v?C.purple:C.dim,
                        }}>{l}</button>
                      ))}
                    </div>
                    <textarea
                      value={feedbackText}
                      onChange={e=>setFeedbackText(e.target.value)}
                      placeholder={
                        feedbackType==='bug'        ? 'Describe the bug - what happened and what you expected...' :
                        feedbackType==='praise'     ? 'What are you loving about the app?' :
                        feedbackType==='suggestion' ? 'What feature or improvement would help most?' :
                                                      'What is on your mind?'
                      }
                      rows={4}
                      style={{
                        width:'100%',background:C.bgDeep,border:`1px solid ${C.border}`,
                        borderRadius:6,color:C.text,fontSize:12,padding:'9px 12px',
                        fontFamily:"'Inter',sans-serif",resize:'vertical',outline:'none',
                        lineHeight:1.5,marginBottom:10,boxSizing:'border-box'
                      }}
                    />
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <button className="hv" onClick={submitFeedback} disabled={feedbackSending||!feedbackText.trim()} style={{
                        background:feedbackText.trim()&&!feedbackSending?C.purple:'transparent',
                        border:`1px solid ${feedbackText.trim()&&!feedbackSending?C.purple:C.border}`,
                        color:feedbackText.trim()&&!feedbackSending?'#fff':C.dim,
                        fontWeight:700,padding:'7px 18px',borderRadius:4,fontSize:12,
                        letterSpacing:.8,cursor:feedbackText.trim()&&!feedbackSending?'pointer':'not-allowed'
                      }}>{feedbackSending?'SENDING…':'SEND FEEDBACK'}</button>
                      {feedbackSent&&<span style={{fontSize:11,color:C.green}}>✓ Thanks — feedback received!</span>}
                      {feedbackErr&&<span style={{fontSize:11,color:C.red}}>{feedbackErr}</span>}
                    </div>
                  </Card>

                  {/* Account */}
                  <Card C={C} style={{marginBottom:12}}>
                    <Lbl C={C} color={C.dim}>👤 ACCOUNT</Lbl>
                    {userEmail&&<div style={{fontSize:11,color:C.subtext,marginBottom:10,fontFamily:"'IBM Plex Mono',monospace"}}>{userEmail}</div>}
                    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                      <button className="hv" onClick={openPortal} style={{
                        background:`${C.green}18`,border:`1px solid ${C.green}40`,color:C.green,
                        padding:'7px 14px',borderRadius:4,fontSize:12,fontWeight:700,letterSpacing:.8,cursor:'pointer'
                      }}>MANAGE BILLING</button>
                      <button className="hv" onClick={onSignOut} style={{
                        background:'transparent',border:`1px solid ${C.border}`,color:C.dim,
                        padding:'7px 14px',borderRadius:4,fontSize:12,letterSpacing:.8,cursor:'pointer'
                      }}>SIGN OUT</button>
                    </div>
                  </Card>

                </div>
              )}

              {/* ── CHECKLIST ── */}
              {toolsTab==='checklist'&&(
                <div className="si">
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
                    <div>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:22,color:clColor,letterSpacing:0.3}}>
                        {clScore}% — {clScore>=80?'STRONG SETUP 🔥':clScore>=60?'CAUTION ⚠️':'SKIP ❌'}
                      </div>
                      <div style={{fontSize:12,color:C.dim}}>{Object.values(checked).filter(Boolean).length} of {CHECKLIST.length} met</div>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <div style={{width:70,height:5,background:C.border,borderRadius:3,overflow:'hidden'}}>
                        <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s'}}/>
                      </div>
                      <button className="hv" onClick={()=>setChecked({})} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'4px 9px',borderRadius:3,fontSize:11,cursor:'pointer'}}>RESET</button>
                    </div>
                  </div>
                  {['TA','Flow','News','Risk'].map(cat=>(
                    <div key={cat} style={{marginBottom:13}}>
                      <div style={{fontSize:11,letterSpacing:2,color:CAT_COLOR[cat],marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
                        <span style={{display:'inline-block',width:12,height:1.5,background:CAT_COLOR[cat]}}/>
                        {cat==='TA'?'TECHNICAL':cat==='Flow'?'OPTIONS FLOW':cat==='News'?'NEWS / CATALYST':'RISK MGMT'}
                      </div>
                      {CHECKLIST.filter(i=>i.cat===cat).map(item=>(
                        <div key={item.id} className="hv" onClick={()=>setChecked(p=>({...p,[item.id]:!p[item.id]}))}
                          style={{display:'flex',gap:9,padding:'9px 12px',borderRadius:8,marginBottom:4,
                            background:checked[item.id]?`${CAT_COLOR[cat]}0a`:C.card,
                            border:`1px solid ${checked[item.id]?CAT_COLOR[cat]+'40':C.border}`}}>
                          <div style={{width:14,height:14,borderRadius:2,border:`2px solid ${checked[item.id]?CAT_COLOR[cat]:C.border}`,background:checked[item.id]?CAT_COLOR[cat]:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1}}>
                            {checked[item.id]&&<span style={{color:'#1c1916',fontSize:11,fontWeight:700}}>✓</span>}
                          </div>
                          <div>
                            <div style={{fontSize:12,color:checked[item.id]?C.text:C.subtext,fontFamily:"'Inter',sans-serif"}}>{item.l}</div>
                            <div style={{fontSize:11,color:C.subtext,marginTop:1,fontFamily:"'Inter',sans-serif"}}>{item.d}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* ── STRATEGY ── */}
              {toolsTab==='strategy'&&(
                <div className="si">
                  {[
                    {t:'CALLS & PUTS',c:C.green,rules:['2+ TA signals required before entry','Avoid RSI > 75 (calls) or < 25 (puts)','Volume 1.5x+ above 20-day average','MACD crossover confirms direction','Options flow sweep = green light','21–45 DTE swings, 5–14 DTE quick plays']},
                    {t:'SPREADS',c:C.blue,rules:['Debit spreads when IVR < 30','Credit spreads when IVR > 50','Short strike at key S/R level','Min 1:1 risk/reward, target 1:2','Width: 5–10pts SPX, 2.5–5 stocks','Target 50–65% of max profit on credit']},
                    {t:'CONDORS & STRANGLES',c:C.orange,rules:['IVR > 50 ideally > 70','No earnings/events within expiry','ATR contracting 5+ sessions','Sell 1–2 SD OTM strikes','Collect 25–33% of width as credit','Close at 50% profit or 21 DTE']},
                  ].map((s,i)=>(
                    <div key={i} style={{marginBottom:14}}>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:15,color:s.c,letterSpacing:0.3,marginBottom:6}}>{s.t}</div>
                      {s.rules.map((r,j)=>(
                        <div key={j} style={{display:'flex',gap:8,marginBottom:4,fontSize:11,color:C.subtext}}>
                          <span style={{color:s.c,flexShrink:0}}>→</span>{r}
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{background:C.panel,border:`1px dashed ${C.border}`,borderRadius:4,padding:11,fontSize:11,color:C.subtext,lineHeight:1.7}}>
                    <span style={{fontSize:11,color:C.dim,letterSpacing:2}}>GOLDEN RULE — </span>
                    Require <span style={{color:C.green}}>2+ TA</span> + <span style={{color:C.blue}}>1 flow</span> or <span style={{color:C.orange}}>1 catalyst</span> before entry.
                  </div>
                </div>
              )}

              {/* ── EXIT RULES ── */}
              {toolsTab==='exit'&&(
                <div className="si">
                  {EXIT_RULES.map((sec,i)=>(
                    <div key={i} style={{marginBottom:16}}>
                      <div style={{fontFamily:"'Fraunces',serif",fontSize:15,color:sec.color,letterSpacing:0.3,marginBottom:7}}>{sec.type}</div>
                      {sec.rules.map((r,j)=>(
                        <div key={j} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${sec.color}`,borderRadius:4,padding:'8px 12px',display:'grid',gridTemplateColumns:'100px 1fr',gap:8,alignItems:'center',marginBottom:4}}>
                          <span style={{fontSize:11,color:sec.color,letterSpacing:.8,fontWeight:600}}>{r.tr.toUpperCase()}</span>
                          <span style={{fontSize:11,color:C.subtext,lineHeight:1.5}}>{r.a}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <Card color={`${C.red}50`}>
                    <Lbl C={C} color={C.red}>⚠️ CARDINAL RULES</Lbl>
                    {['Never widen your stop to give it more room','If unsure whether to exit — exit. Re-enter later','Always post exits to your Telegram channel','Partial exits: book 50% at target, trail the rest'].map((r,i)=>(
                      <div key={i} style={{display:'flex',gap:7,marginBottom:4,fontSize:11,color:C.subtext}}>
                        <span style={{color:C.red,flexShrink:0}}>→</span>{r}
                      </div>
                    ))}
                  </Card>
                </div>
              )}

              {/* ── FUTURES ── */}
              {toolsTab==='futures'&&(
                <div className="si">
                  <div style={{display:'flex',gap:6,marginBottom:11,flexWrap:'wrap'}}>
                    {Object.entries(FUT_SYMBOLS).map(([sym,cfg])=>(
                      <button key={sym} className="hv" onClick={()=>{setFutSym(sym);setFutData(null);setFutErr('')}} style={{
                        padding:'7px 12px',borderRadius:4,cursor:'pointer',
                        fontFamily:"'Fraunces',serif",fontSize:13,letterSpacing:1.5,
                        border:`1px solid ${futSym===sym?C.green:C.border}`,
                        color:futSym===sym?C.green:C.dim,
                        background:futSym===sym?`${C.green}18`:C.card,
                      }}>
                        <div>{cfg.display}</div>
                        <div style={{fontSize:11,fontFamily:"'IBM Plex Mono',monospace",opacity:.6,marginTop:1}}>{cfg.name.split('—')[1]?.trim()||''}</div>
                      </button>
                    ))}
                  </div>

                  <button className="hv" onClick={()=>fetchFutures(futSym)} disabled={futLoading} style={{
                    width:'100%',padding:'11px',borderRadius:5,fontSize:12,letterSpacing:2,
                    fontFamily:"'Fraunces',serif",marginBottom:10,cursor:'pointer',
                    background:futLoading?`${C.blue}10`:`${C.blue}22`,
                    border:`1px solid ${futLoading?C.border:C.blue}`,
                    color:futLoading?C.dim:C.blue,
                  }}>
                    {futLoading?<span className="pulse">🔴 FETCHING {FUT_SYMBOLS[futSym]?.display}...</span>:`📡 FETCH ${futSym} — ${FUT_SYMBOLS[futSym]?.name}`}
                  </button>

                  {futErr&&(
                    <div style={{background:C.bgDeep,border:`1px solid ${C.red}40`,borderRadius:5,padding:10,marginBottom:10,lineHeight:1.6}}>
                      <div style={{color:C.red,fontSize:11,marginBottom:5}}>{futErr}</div>
                      <div style={{fontSize:12,color:C.subtext}}>
                        <strong style={{color:C.orange}}>Tip:</strong> Futures + index symbols need a production-tier data connection.
                        The ETF proxy (SPY/QQQ etc.) always works — it's loaded as final fallback automatically.
                        If all 3 fail, the market data connection may be missing or invalid.
                      </div>
                    </div>
                  )}

                  {futData&&(
                    <div>
                      <div style={{marginBottom:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                          <div>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:18,color:C.text,letterSpacing:0.3}}>
                              {futData.cfg.display} <span style={{fontSize:11,color:futData.usingFutures?C.green:C.orange}}>{futData.usingFutures?'● LIVE':'● INDEX'}</span>
                            </div>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:34,color:futData.biasColor,letterSpacing:0.3}}>${futData.price.toFixed(2)}</div>
                            <div style={{display:'flex',gap:8,alignItems:'center',marginTop:3}}>
                              <span style={{fontSize:12,color:futData.chgPct>=0?C.green:C.red}}>{futData.chgPct>=0?'+':''}{futData.chgPct.toFixed(2)}%</span>
                              <span style={{fontSize:12,color:futData.biasColor,padding:'1px 7px',borderRadius:3,border:`1px solid ${futData.biasColor}40`,background:`${futData.biasColor}15`}}>{futData.bias}</span>
                              <span style={{fontSize:11,color:C.dim}}>{futData.fetchedAt}</span>
                            </div>
                          </div>
                          <button className="hv" onClick={()=>fetchFutures(futData.sym)} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:3,fontSize:11,cursor:'pointer'}}>↺ REFRESH</button>
                        </div>

                        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:10}}>
                          {[
                            {l:'OPEN',  v:'$'+futData.open.toFixed(2),  c:C.text},
                            {l:'HIGH',  v:'$'+futData.hi.toFixed(2),    c:C.green},
                            {l:'LOW',   v:'$'+futData.lo.toFixed(2),    c:C.red},
                            {l:'52W HI',v:'$'+futData.hi52.toFixed(2),  c:C.green},
                            {l:'52W LO',v:'$'+futData.lo52.toFixed(2),  c:C.red},
                            {l:'CHAIN', v:futData.chainLen+' opts',      c:C.dim},
                          ].map((f,i)=>(
                            <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:'6px 8px'}}>
                              <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>{f.l}</div>
                              <div style={{fontSize:11,color:f.c,fontWeight:600}}>{f.v}</div>
                            </div>
                          ))}
                        </div>

                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                          <div style={{background:C.bgDeep,border:`1px solid ${C.red}40`,borderRadius:5,padding:11}}>
                            <Lbl C={C} color={C.red}>🔴 RESISTANCE</Lbl>
                            {futData.resistance.length===0
                              ?<div style={{fontSize:11,color:C.dim}}>None found</div>
                              :futData.resistance.map((lvl,i)=>(
                                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<futData.resistance.length-1?`1px solid ${C.border}`:'none'}}>
                                  <span style={{fontFamily:"'Fraunces',serif",fontSize:15,color:C.red}}>${lvl.toFixed(2)}</span>
                                  <span style={{fontSize:11,color:C.dim}}>{((lvl/futData.price-1)*100).toFixed(1)}%</span>
                                </div>
                              ))
                            }
                          </div>
                          <div style={{background:C.bgDeep,border:`1px solid ${C.green}40`,borderRadius:5,padding:11}}>
                            <Lbl C={C} color={C.green}>🟢 SUPPORT</Lbl>
                            {futData.support.length===0
                              ?<div style={{fontSize:11,color:C.dim}}>None found</div>
                              :futData.support.map((lvl,i)=>(
                                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<futData.support.length-1?`1px solid ${C.border}`:'none'}}>
                                  <span style={{fontFamily:"'Fraunces',serif",fontSize:15,color:C.green}}>${lvl.toFixed(2)}</span>
                                  <span style={{fontSize:11,color:C.dim}}>{(((lvl/futData.price)-1)*100).toFixed(1)}%</span>
                                </div>
                              ))
                            }
                          </div>
                        </div>

                        {futData.tradeSetups.length>0&&(
                          <div>
                            <Lbl C={C}>TRADE SETUPS</Lbl>
                            {futData.tradeSetups.map((s,i)=>(
                              <div key={i} style={{background:C.card,border:`1px solid ${s.color}40`,borderRadius:5,padding:10,marginBottom:7}}>
                                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                                  <div style={{display:'flex',gap:7,alignItems:'center'}}>
                                    <span style={{fontFamily:"'Fraunces',serif",fontSize:15,color:s.color,letterSpacing:0.3}}>{s.type}</span>
                                    <span style={{fontSize:11,color:C.text}}>{s.strike}</span>
                                    <span style={{fontSize:11,color:s.color,border:`1px solid ${s.color}40`,padding:'1px 5px',borderRadius:2}}>{s.conviction}</span>
                                  </div>
                                </div>
                                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4}}>
                                  {[
                                    {l:'ENTRY',v:s.entry,c:C.blue},
                                    {l:'TARGET',v:s.target,c:C.green},
                                    {l:'STOP',v:s.stop,c:C.red},
                                  ].map((f,j)=>(
                                    <div key={j} style={{background:C.cardAlt,borderRadius:3,padding:'5px 7px'}}>
                                      <div style={{fontSize:7,color:C.dim,letterSpacing:1.5,marginBottom:1}}>{f.l}</div>
                                      <div style={{fontSize:12,color:f.c,fontWeight:600}}>{f.v}</div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{display:'flex',gap:12,marginTop:6,fontSize:12,color:C.dim}}>
                                  <span>IV: <span style={{color:C.subtext}}>{s.iv}</span></span>
                                  <span>Δ: <span style={{color:C.subtext}}>{s.delta}</span></span>
                                  <span>OI: <span style={{color:C.subtext}}>{s.oi.toLocaleString()}</span></span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      )}

        {/* ── ADMIN TAB ────────────────────────────────────────────────── */}
        {tab==='admin' && isAdmin && (
          <div className="si" style={{maxWidth:700,margin:'0 auto',padding:'0 16px'}}>

            {/* Full admin dashboard — KPIs, signups, feature usage, health.
                Manages its own data fetch/loading/error state internally. */}
            <AdminDashboard getToken={getAuthToken} theme={C} />

            {/* Feedback Viewer */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'16px 20px',marginBottom:12,boxShadow:C.shadow}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <span style={{fontSize:12,color:C.purple,letterSpacing:1,fontWeight:700,textTransform:'uppercase'}}>💬 User Feedback</span>
                <button className="hv" onClick={loadAdminFeedback} disabled={adminFbLoading} style={{background:`${C.purple}18`,border:`1px solid ${C.purple}40`,color:C.purple,padding:'4px 12px',borderRadius:4,fontSize:11,cursor:'pointer',letterSpacing:.5}}>
                  {adminFbLoading?'Loading…':'↺ LOAD'}
                </button>
              </div>
              {adminFbErr&&<div style={{fontSize:11,color:C.red,background:`${C.red}12`,border:`1px solid ${C.red}30`,borderRadius:4,padding:'8px 10px',marginBottom:8}}>Error: {adminFbErr}</div>}
              {adminFeedback.length===0&&!adminFbLoading&&!adminFbErr&&(
                <div style={{fontSize:12,color:C.dim,textAlign:'center',padding:'12px 0'}}>Click LOAD to fetch feedback</div>
              )}
              {adminFeedback.map((fb,i)=>(
                <div key={i} style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:6,padding:'10px 12px',marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5,flexWrap:'wrap',gap:4}}>
                    <span style={{fontSize:10,fontWeight:700,letterSpacing:.5,color:fb.type==='bug'?C.red:fb.type==='praise'?C.green:C.purple,background:fb.type==='bug'?`${C.red}15`:fb.type==='praise'?`${C.green}15`:`${C.purple}15`,border:`1px solid ${fb.type==='bug'?C.red:fb.type==='praise'?C.green:C.purple}40`,padding:'2px 7px',borderRadius:3}}>{fb.type?.toUpperCase()}</span>
                    <span style={{fontSize:10,color:C.dim}}>{fb.email||'anonymous'} · {fb.created_at?new Date(fb.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}</span>
                  </div>
                  <div style={{fontSize:12,color:C.text,lineHeight:1.5}}>{fb.message}</div>
                </div>
              ))}
            </div>

          </div>
        )}

    </div>
  )
}
