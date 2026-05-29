import { useState, useEffect, useRef, useCallback } from 'react'
import { useUser, useAuth, SignOutButton } from '@clerk/clerk-react'

// ─── Safe localStorage helper ─────────────────────────────────────────────────
const ls = (key, fallback='') => {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

// ─── Theme ────────────────────────────────────────────────────────────────────
const DARK_THEME = {
  green:'#00ff88', blue:'#00c8ff', orange:'#ff9500',
  red:'#ff4466',   dim:'#4a7a8a',  card:'#0d1a26',
  bg:'#090e14',    border:'#1a2e3e',
  text:'#c8d8e8',  subtext:'#6a9aaa', isDark:true,
}
const LIGHT_THEME = {
  green:'#007a3d', blue:'#0066cc', orange:'#c05800',
  red:'#cc1133',   dim:'#5a7a8a',  card:'#f0f4f8',
  bg:'#ffffff',    border:'#cbd5e0',
  text:'#1a2e3e',  subtext:'#4a6070', isDark:false,
}

// Module-level C = dark theme default.
// Must be declared here — before TF_CONFIG, EXIT_RULES etc. reference C.green/C.blue.
// Inside App(), `const C = isDark ? DARK_THEME : LIGHT_THEME` shadows this for all JSX.
const C = DARK_THEME

// ─── Helpers ──────────────────────────────────────────────────────────────────
const autoStep = p => p<25?.5:p<50?1:p<100?2:p<250?5:p<500?10:p<1000?20:50
const fmtP   = n => n==null?'—':'$'+parseFloat(n).toFixed(2)
const fmtPct = n => n==null?'—':(parseFloat(n)*100).toFixed(1)+'%'
const safe   = v => v==null?'—':typeof v==='object'?JSON.stringify(v):String(v)

// ─── Module-level constants ───────────────────────────────────────────────────
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

// approxGEX: proxy Gamma Exposure from chain data.
// Real GEX = gamma × OI × 100 × price². We don't have gamma directly from
// Tradier greeks names, but mid_iv + delta let us approximate it via
// Black-Scholes approximation: gamma ≈ delta(1-delta)/(price × iv × √(dte/365))
// Since dte isn't per-contract, we use a constant 30-day proxy. The relative
// ranking across strikes is what matters, not the absolute value.
const approxGEX = (o, price) => {
  const oi    = parseFloat(o.open_interest||0)
  const iv    = parseFloat(o.greeks?.mid_iv||o.implied_volatility||0.3)
  const delta = Math.abs(parseFloat(o.greeks?.delta||0.5))
  if (!oi || iv===0) return 0
  // gamma proxy: bell-shaped, peaks at delta=0.5
  const gammaPx = delta*(1-delta) / (price * iv * Math.sqrt(30/365))
  // For calls: positive GEX (dealers long gamma → pinning)
  // For puts: negative GEX (dealers short gamma → acceleration)
  const sign = o.option_type==='call' ? 1 : -1
  return sign * gammaPx * oi * 100
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
  const tgt  = Math.round(price*pct/step)*step
  const side = chain.filter(o=>o.option_type===optType)

  // Use GEX+OI+Volume scoring to find the best strike
  const best = findBestStrike(side, tgt, price)
  if (!best) return null
  const b=parseFloat(best.bid||0), a=parseFloat(best.ask||0), m=(b+a)/2
  if (m===0) return null
  const f2 = v => Math.max(0,v).toFixed(2)

  // Strike quality signals for display
  const allOI  = Math.max(...side.map(o=>parseFloat(o.open_interest||0)),1)
  const allVol = Math.max(...side.map(o=>parseFloat(o.volume||0)),1)
  const sc     = scoreStrike(best, price, allOI, allVol)
  const gex    = approxGEX(best, price)
  const strikeQuality = sc>=0.60?'⭐ HIGH CONVICTION':sc>=0.35?'MODERATE':'LOW — check liquidity'

  return {
    strikeStr:     `$${best.strike}${suf}`,
    bid:b, ask:a, mid:m,
    entry:         `$${f2(m*0.95)} – $${f2(m*1.05)}  (mid $${f2(m)})`,
    target:        `$${f2(m*(1+tfCfg.profitTarget))}  (+${(tfCfg.profitTarget*100).toFixed(0)}%)`,
    stop:          `$${f2(m*(1-tfCfg.stopLoss))}  (−${(tfCfg.stopLoss*100).toFixed(0)}%)`,
    structureType: optType==='call' ? 'Long Call' : 'Long Put',
    legs:          null,
    iv:            best.greeks?.mid_iv||best.implied_volatility||0,
    delta:         best.greeks?.delta||null,
    theta:         best.greeks?.theta||null,
    volume:        best.volume||0,
    oi:            best.open_interest||0,
    primaryStrike: best.strike,
    strikeScore:   sc,
    strikeQuality,
    gexSign:       gex>=0?'positive':'negative',
    gexNote:       gex>=0
      ? `Dealers long gamma at $${best.strike} — price pinning / support zone`
      : `Dealers short gamma at $${best.strike} — momentum accelerator / breakout zone`,
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
      iv:longLeg.greeks?.mid_iv||0, delta:longLeg.greeks?.delta||null,
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
      iv:longLeg.greeks?.mid_iv||0, delta:longLeg.greeks?.delta||null,
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
      iv:cs.greeks?.mid_iv||0, delta:cs.greeks?.delta||null,
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
      iv:mid_.greeks?.mid_iv||0, delta:mid_.greeks?.delta||null,
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
      iv:cLeg.greeks?.mid_iv||0, delta:null,
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
const iSt = {
  width:'100%', background:C.card, border:`1px solid ${C.border}`,
  borderRadius:4, color:C.text, padding:'9px 12px',
  fontSize:12, fontFamily:'inherit',
}

function Field({ label, value, onChange, placeholder, options, rows, type='text' }) {
  return (
    <div>
      <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4,textTransform:'uppercase'}}>{label}</div>
      {options
        ? <select value={value} onChange={e=>onChange(e.target.value)} style={iSt}>
            {options.map(o=><option key={o.v||o} value={o.v||o}>{o.l||o}</option>)}
          </select>
        : rows
          ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{...iSt,resize:'vertical'}}/>
          : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={iSt}/>
      }
    </div>
  )
}

function Card({ color, children, style={} }) {
  return (
    <div style={{background:C.card,border:`1px solid ${color||C.border}`,borderRadius:6,padding:14,...style}}>
      {children}
    </div>
  )
}

function Lbl({ children, color=C.dim }) {
  return <div style={{fontSize:9,color,letterSpacing:2,marginBottom:6,textTransform:'uppercase'}}>{children}</div>
}

function Pill({ label, active, color=C.green, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:'7px 14px',borderRadius:4,fontSize:11,letterSpacing:.8,cursor:'pointer',
      border:`1px solid ${active?color:C.border}`,color:active?color:C.dim,
      background:active?`${color}18`:'transparent',
    }}>{label}</button>
  )
}

// ─── P&L Sparkline ────────────────────────────────────────────────────────────
function PnLChart({ trades }) {
  const closed = [...trades].filter(t=>t.status!=='Open').reverse()
  if (closed.length < 2) return (
    <div style={{textAlign:'center',padding:'20px 0',fontSize:11,color:C.dim,border:`1px dashed ${C.border}`,borderRadius:6}}>
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
  const lineColor = lastY>=0?C.green:C.red
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
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={C.border} strokeWidth={1} strokeDasharray="4,4"/>
        <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#pgrd)"/>
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.8}/>
        <circle cx={(cumPnL.length-1)/(cumPnL.length-1)*W} cy={toY(lastY)} r={3} fill={lineColor}/>
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:9,color:C.dim,marginTop:3,letterSpacing:.5}}>
        <span>{closed[0]?.date||closed[0]?.ticker||''}</span>
        <span>{closed[closed.length-1]?.date||closed[closed.length-1]?.ticker||''}</span>
      </div>
    </div>
  )
}

// ─── Tradier API proxy ────────────────────────────────────────────────────────
async function tradierGet(path, token, mode) {
  const res = await fetch(`/api/tradier?path=${encodeURIComponent(path)}`, {
    headers:{'x-tradier-token':token,'x-tradier-mode':mode},
  })
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${await res.text().catch(()=>'')}`)
  return res.json()
}

async function sendTelegram(message, token, chatId) {
  const res = await fetch('/api/telegram', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message,token,chat_id:chatId}),
  })
  return res.json()
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {

  // ── theme ──
  const [isDark, setIsDark] = useState(()=>ls('isDark','1')==='1')
  useEffect(()=>{try{localStorage.setItem('isDark',isDark?'1':'0')}catch{}},[isDark])
  const C = isDark ? DARK_THEME : LIGHT_THEME

  // ── main tab & tools panel ──
  const [tab,        setTab]        = useState('dash')
  const [btFilter,   setBtFilter]   = useState('all')    // backtest filter
  const [paperToast, setPaperToast] = useState('')        // confirmation toast
  const [showTools,  setShowTools]  = useState(false)
  const [toolsTab,   setToolsTab]   = useState('settings')

  // ── settings ──
  const [anthropicKey,  setAnthropicKey]  = useState(()=>ls('anthropicKey'))
  const [tradierToken, setTradierToken] = useState(()=>ls('tradierToken'))
  const [tradierMode,  setTradierMode]  = useState(()=>ls('tradierMode','production'))
  const [tgToken,      setTgToken]      = useState(()=>ls('tgToken'))
  const [tgChatId,     setTgChatId]     = useState(()=>ls('tgChatId'))
  const [watchlist,    setWatchlist]    = useState(()=>ls('watchlist','NVDA,AAPL,MSFT,SPY,TSLA'))
  const [minScore,     setMinScore]     = useState(()=>Number(ls('minScore','80')))
  const [scanFreq,     setScanFreq]     = useState(()=>Number(ls('scanFreq','5')))
  const [tgStatus,     setTgStatus]     = useState('')

  useEffect(()=>{try{localStorage.setItem('anthropicKey', anthropicKey)}catch{}},[anthropicKey])
  useEffect(()=>{try{localStorage.setItem('tradierToken',tradierToken)}catch{}},[tradierToken])
  useEffect(()=>{try{localStorage.setItem('tradierMode', tradierMode)} catch{}},[tradierMode])
  useEffect(()=>{try{localStorage.setItem('tgToken',     tgToken)}     catch{}},[tgToken])
  useEffect(()=>{try{localStorage.setItem('tgChatId',    tgChatId)}    catch{}},[tgChatId])
  useEffect(()=>{try{localStorage.setItem('watchlist',   watchlist)}   catch{}},[watchlist])
  useEffect(()=>{try{localStorage.setItem('minScore',    String(minScore))}catch{}},[minScore])
  useEffect(()=>{try{localStorage.setItem('scanFreq',    String(scanFreq))}catch{}},[scanFreq])

  // ── price bar ──
  const [esBar, setEsBar] = useState(null)
  const [nqBar, setNqBar] = useState(null)
  const [barLoading, setBarLoading] = useState(false)

  // ── index alerts & conviction ──
  const [indexAlerts,        setIndexAlerts]        = useState([])
  const [indexAlertsLoading, setIndexAlertsLoading] = useState(false)
  const [marketConviction,   setMarketConviction]   = useState(null)
  const [morningBrief,       setMorningBrief]       = useState('')
  const [briefLoading,       setBriefLoading]       = useState(false)

  // ── checklist ──
  const [checked, setChecked] = useState({})
  const clScore = Math.round(Object.values(checked).filter(Boolean).length/CHECKLIST.length*100)
  const clColor = clScore>=80?C.green:clScore>=60?C.orange:C.red

  // ── alert builder ──
  const [alert, setAlert] = useState({
    type:'Call',ticker:'',expiry:'',strike:'',entry:'',
    target:'',stop:'',size:'1–2 contracts',thesis:'',catalyst:'',flow:'',
  })
  const [copied, setCopied] = useState(false)

  // ── journal ──
  const [trades,   setTrades]   = useState(()=>{try{return JSON.parse(ls('trades','[]'))}catch{return[]}})
  const [showAdd,  setShowAdd]  = useState(false)
  const [jFilter,  setJFilter]  = useState('All')
  const [newTrade, setNewTrade] = useState({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:'',conviction:'',iv:'',chgPctAtEntry:'',strike:'',breakevenReqPct:''})
  useEffect(()=>{try{localStorage.setItem('trades',JSON.stringify(trades))}catch{}},[trades])

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
  const [scanTicker, setScanTicker] = useState('')
  const [scanType,   setScanType]   = useState('Any')
  const [scanTF,     setScanTF]     = useState('Swing (21–45 DTE)')
  const [scanning,   setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanErr,    setScanErr]    = useState('')
  const [debugLog,   setDebugLog]   = useState([])

  // ── auto-scanner ──
  const [autoOn,      setAutoOn]      = useState(false)
  const [autoLog,     setAutoLog]     = useState([])
  const [lastAlert,   setLastAlert]   = useState(null)
  const [alertCopied, setAlertCopied] = useState(false)
  const autoRef    = useRef(null)
  const scanTFRef  = useRef(scanTF)   // always holds live scanTF — avoids stale closure in interval
  useEffect(()=>{ scanTFRef.current = scanTF },[scanTF])

  // ── futures (tools panel) ──
  const [futSym,     setFutSym]     = useState('ES')
  const [futData,    setFutData]    = useState(null)
  const [futLoading, setFutLoading] = useState(false)
  const [futErr,     setFutErr]     = useState('')

  // ─── Tradier helpers ──────────────────────────────────────────────────────
  const tGet     = useCallback((path)=>tradierGet(path,tradierToken,tradierMode),[tradierToken,tradierMode])
  const getQuote    = async t=>{const d=await tGet(`/markets/quotes?symbols=${t}&greeks=false`);return d?.quotes?.quote||null}
  const getExpiries = async t=>{const d=await tGet(`/markets/options/expirations?symbol=${t}&includeAllRoots=false`);return d?.expirations?.date||[]}
  const getChain    = async(t,e)=>{const d=await tGet(`/markets/options/chains?symbol=${t}&expiration=${e}&greeks=true`);return d?.options?.option||[]}

  // ─── Price bar fetch ──────────────────────────────────────────────────────
  const fetchPriceBar = useCallback(async()=>{
    setBarLoading(true)
    const tryQuote = async symbols => {
      for (const sym of symbols) {
        try {
          const q = await getQuote(sym)
          const p = parseFloat(q?.last||q?.prevclose||0)
          if (p) return { price:p, chgPct:parseFloat(q.change_percentage||0), chg:parseFloat(q.change||0), sym }
        } catch {}
      }
      return null
    }
    // SPX/NDX are the primary symbols — direct Tradier index quotes
    const [es, nq] = await Promise.all([
      tryQuote(['SPX','$SPX.X','SPY']),
      tryQuote(['NDX','$NDX.X','QQQ']),
    ])
    if (es) setEsBar({...es, label:'SPX'})
    if (nq) setNqBar({...nq, label:'NDX'})
    // Update market conviction whenever prices refresh
    if (es) {
      const spxChg = es.chgPct
      const ndxChg = nq?.chgPct || spxChg
      const volR   = 1 // volume not in bar data — neutral
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
      setMarketConviction({ score: bull, direction: dir, spxChg, ndxChg,
        color: dir==='BULLISH'?C.green:dir==='BEARISH'?C.red:C.orange })
    }
    setBarLoading(false)
  },[tradierToken,tradierMode])

  useEffect(()=>{ fetchPriceBar() },[]) // fetch on mount

  // ─── Single ticker scan ───────────────────────────────────────────────────
  const runScan = async()=>{
    if (!scanTicker.trim()) return
    const log=[]; const dbg=m=>{log.push(m);setDebugLog([...log])}
    setScanning(true);setScanResult(null);setScanErr('');setDebugLog([])
    const ticker=scanTicker.toUpperCase()
    try {
      dbg(`1. Fetching live quote for $${ticker}...`)
      const quote=await getQuote(ticker)
      if (!quote) throw new Error('No quote — check ticker and token')
      const price=parseFloat(quote.last||quote.prevclose||0)
      if (!price) throw new Error('Price is $0 — market may be closed')
      dbg(`   ✓ $${ticker} = $${price.toFixed(2)} | chg: ${parseFloat(quote.change_percentage||0).toFixed(2)}%`)

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

      const chgPct=parseFloat(quote.change_percentage||0)
      const bearish=scanType==='Put'||scanType==='Put Spread'||(scanType==='Any'&&chgPct<-0.5)
      const optType=bearish?'put':'call'
      const tradeType=scanType==='Any'?(bearish?'Put':'Call'):scanType

      const step=autoStep(price)
      const strikePct=bearish?(2-tfCfg.strikePct):tfCfg.strikePct
      const tgtStrike=Math.round(price*strikePct/step)*step
      const side=chain.filter(o=>o.option_type===optType)
      if (!side.length) throw new Error(`No ${optType} contracts found`)
      const best=side.reduce((a,b)=>Math.abs(b.strike-tgtStrike)<Math.abs(a.strike-tgtStrike)?b:a)
      const bid=parseFloat(best.bid||0)
      const ask=parseFloat(best.ask||0)
      const mid=(bid+ask)/2
      if (mid===0) throw new Error('Bid/ask both $0 — no liquidity')
      const iv=best.greeks?.mid_iv||best.implied_volatility||0
      const delta=best.greeks?.delta||null
      const theta=best.greeks?.theta||null
      dbg(`   ✓ Strike: $${best.strike}${optType==='call'?'C':'P'} | Bid: ${fmtP(bid)} | Ask: ${fmtP(ask)} | Mid: ${fmtP(mid)}`)
      dbg(`   ✓ IV: ${fmtPct(iv)} | Delta: ${delta?.toFixed(3)||'—'} | Theta: ${theta?.toFixed(3)||'—'}`)

      const vol=quote.volume||0,avgVol=quote.average_volume||vol
      const volRatio=vol/(avgVol||1)
      const ivPct=iv*100
      const now=new Date()
      const etHour=now.getHours()+(now.getMinutes()/60)
      const isMorningNoise=etHour<10.0
      const isChasing=Math.abs(chgPct)>2.0&&!isSpread
      const isHighIV=iv>0.55&&!isSpread

      // Market regime — use esBar/nqBar already in state as directional context
      const spxChgToday  = esBar?.chgPct||0
      const ndxChgToday  = nqBar?.chgPct||0
      const marketFalling= spxChgToday<-0.5 && ndxChgToday<-0.5
      const marketRising = spxChgToday>0.5  && ndxChgToday>0.5
      const hi52=quote.week_52_high||price,lo52=quote.week_52_low||price
      const pos52=(price-lo52)/((hi52-lo52)||1)
      const expiryDateObj=new Date(expiryRaw+'T12:00:00')
      const dte=Math.round((expiryDateObj-now)/(1000*60*60*24))

      let score=50; const reasons=[],warnings=[],hardBlocks=[]

      // Hard blocks — cap at 48 regardless of other signals
      if(isMorningNoise){
        // No score penalty — a genuinely strong setup is still valid at open.
        // But surface a clear contextual warning so the user can make an informed call.
        warnings.push('🔔 MARKET OPEN — First 30 min are volatile. Spreads are wider, volume signals are unreliable, and IV is inflated. If conviction is high, size smaller than normal and use a limit order at mid or better.')
      }
      if(isChasing){hardBlocks.push(`🚨 Already ${chgPct>0?'+':''}${chgPct.toFixed(1)}% today — chasing inflated premium. Wait for pullback.`);score=Math.min(score,42)}
      if(isHighIV){hardBlocks.push(`🔥 IV ${ivPct.toFixed(0)}% is high — buying here is expensive. Consider credit spread or wait for IV to compress.`);score=Math.min(score,48)}

      // ── Market regime scoring ────────────────────────────────────────────
      if(marketFalling && optType==='call' && !isSpread){
        score-=12
        warnings.push(`Market headwind — SPX ${spxChgToday.toFixed(1)}% / NDX ${ndxChgToday.toFixed(1)}% today. Calls face drag when index is falling.`)
      } else if(marketRising && optType==='put' && !isSpread){
        score-=10
        warnings.push(`Market headwind — SPX ${spxChgToday.toFixed(1)}% / NDX ${ndxChgToday.toFixed(1)}% today. Puts face drag when index is rising.`)
      } else if(marketRising && optType==='call'){
        score+=6;reasons.push(`Market tailwind — SPX ${spxChgToday.toFixed(1)}%`)
      } else if(marketFalling && optType==='put'){
        score+=6;reasons.push(`Market tailwind — SPX ${spxChgToday.toFixed(1)}% falling`)
      }

      // IV environment
      if(iv>=0.20&&iv<=0.40){score+=12;reasons.push(`IV ${ivPct.toFixed(0)}% — cheap premium`)}
      else if(iv>0.40&&iv<=0.55){score+=6;reasons.push(`IV ${ivPct.toFixed(0)}% — moderate`)}
      else if(iv>0.55&&iv<=0.65){score-=8;warnings.push(`IV ${ivPct.toFixed(0)}% elevated — overpaying`)}
      else if(iv>0.65){score-=15;warnings.push(`IV ${ivPct.toFixed(0)}% HIGH — move already priced in`)}

      // ── Volume + price coherence ─────────────────────────────────────────────
      // Key insight: high volume with tiny move = institutional roll/distribution.
      // Volume only becomes a bullish signal when it ACCOMPANIES significant price action.
      if(!isMorningNoise){
        const volPriceCoherent = volRatio>=1.5 && Math.abs(chgPct)>=1.0
        const volPriceDivergent= volRatio>=3.0 && Math.abs(chgPct)<0.8
        if(volPriceDivergent){
          score-=8
          warnings.push(`Vol ${volRatio.toFixed(1)}x but stock barely moved (${chgPct.toFixed(1)}%) — likely institutional roll or distribution, not directional flow`)
        } else if(volPriceCoherent){
          score+=12;reasons.push(`Vol ${volRatio.toFixed(1)}x avg with ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move — coherent bullish signal`)
        } else if(volRatio>=1.5){
          score+=4
          warnings.push(`Vol ${volRatio.toFixed(1)}x avg but price only ${chgPct.toFixed(1)}% — confirm this is directional before entering`)
        } else if(volRatio<0.8){
          score-=8;warnings.push(`Low volume ${volRatio.toFixed(1)}x — weak conviction`)
        }
      } else {
        // Still score the volume but add the open-volatility context
        if(volRatio>=2.0){score+=8;reasons.push(`Volume ${volRatio.toFixed(1)}x avg`)}
        warnings.push(`🔔 Market open — volume signals less reliable in first 30 min`)
      }

      // ── Price momentum ────────────────────────────────────────────────────
      if(!isChasing){
        if(Math.abs(chgPct)>=1.5&&Math.abs(chgPct)<=2.0){score+=8;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% — clean directional move`)}
        else if(Math.abs(chgPct)>=0.8&&Math.abs(chgPct)<1.5){score+=4;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}% today`)}
        // <0.8% with no other catalyst = neutral, no score added
      } else {warnings.push(`Already moved ${chgPct>0?'+':''}${chgPct.toFixed(1)}% — chasing`)}

      // Delta quality
      if(delta&&Math.abs(delta)>=0.35&&Math.abs(delta)<=0.55){score+=10;reasons.push(`Delta ${delta.toFixed(2)} ideal`)}
      else if(delta&&Math.abs(delta)>=0.25&&Math.abs(delta)<=0.65){score+=5;reasons.push(`Delta ${delta.toFixed(2)}`)}

      // Strike activity
      if(!isMorningNoise&&(best.volume||0)>500){score+=5;reasons.push(`${best.volume} contracts on strike`)}

      // Trend
      if(pos52>0.80){score+=8;reasons.push('Near 52w high — uptrend')}
      else if(pos52>0.65){score+=4}
      else if(pos52<0.20){score-=5;warnings.push('Near 52w low — avoid longs')}

      // ── DTE / IV incompatibility ─────────────────────────────────────────
      if(dte<14&&iv>0.45&&!isSpread){score-=12;warnings.push(`DTE ${dte} + IV ${ivPct.toFixed(0)}% = theta+IV crush. Need 21+ DTE at this IV.`)}
      else if(dte>=21&&dte<=60){score+=5;reasons.push(`${dte} DTE — good buffer`)}

      // ── Break-even reality: feeds directly into score ────────────────────
      if(!isSpread && tradeData && tradeData.mid>0){
        const strike_ = parseFloat(tradeData.primaryStrike||0)
        const beReq_  = ((strike_ + tradeData.mid) / price - 1) * 100
        if(beReq_>5.0){
          score-=14
          warnings.push(`Break-even requires +${beReq_.toFixed(1)}% move — bottom 20% probability. Only enter with strong specific catalyst.`)
        } else if(beReq_>3.5){
          score-=7
          warnings.push(`Break-even requires +${beReq_.toFixed(1)}% move — needs a real catalyst to be viable`)
        } else if(beReq_>0 && beReq_<=2.0){
          score+=5
          reasons.push(`Break-even only +${beReq_.toFixed(1)}% away — realistic target`)
        }
      }

      // ── No-catalyst cap — use data values not string matching ──────────────
      const hasRealSignal = Math.abs(chgPct)>=1.5 || pos52>0.85
      if(!hasRealSignal && hardBlocks.length===0){
        score=Math.min(score,72)
        warnings.push('No identifiable catalyst — technical signals confirm structure but cannot predict direction. Know the specific WHY before entering.')
      }

      if(hardBlocks.length>0) score=Math.min(score,48)
      score=Math.min(95,Math.max(20,score))
      dbg(`   ✓ Conviction: ${score}%`)
      dbg(`✅ All data from Tradier ${tradierMode}`)

      // Build result: spread if explicitly selected, else naked option
      const SPREAD_TYPES = ['Call Spread','Put Spread','Iron Condor','Butterfly','Strangle']
      const isSpread = SPREAD_TYPES.includes(scanType)
      const tradeData = isSpread
        ? buildSpreadResult(chain, price, step, scanType, tfCfg)
        : buildNakedResult (chain, price, step, optType, tfCfg)
      if (!tradeData) throw new Error('Could not find liquid contracts for this structure')
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
        bid:           isSpread ? tradeData.bid : tradeData.bid,
        ask:           isSpread ? tradeData.ask : tradeData.ask,
        mid:           isSpread ? tradeData.mid : tradeData.mid,
        entry:         tradeData.entry,
        target:        tradeData.target,
        stop:          tradeData.stop,
        isSpread,
        legsList:      tradeData.legs||[],
        grade:score>=80?'A':score>=65?'B':'C',
        confidence:score>=80?'High':score>=65?'Medium':'Low',
        price:fmtP(price),
        bid:fmtP(tradeData.bid), ask:fmtP(tradeData.ask), mid:fmtP(tradeData.mid),
        iv:fmtPct(tradeData.iv||iv),ivRaw:tradeData.iv||iv,
        delta:(tradeData.delta||delta)?((tradeData.delta||delta)).toFixed(3):'—',
        theta:(tradeData.theta||theta)?((tradeData.theta||theta)).toFixed(3):'—',
        volume:tradeData.volume||best.volume||0,
        oi:tradeData.oi||best.open_interest||0,
        chgPct:chgPct.toFixed(2)+'%',
        volRatio:volRatio.toFixed(1)+'x',
        reasons,warnings,hardBlocks,
        dte, ivPct:ivPct.toFixed(1),
        breakeven:(parseFloat(tradeData.primaryStrike||best.strike)+tradeData.mid).toFixed(2),
        breakevenPct:(((parseFloat(tradeData.primaryStrike||best.strike)+tradeData.mid)/price-1)*100).toFixed(1),
        tfLabel:tfCfg.label,tfBadge:tfCfg.badge,tfColor:tfCfg.color,
        source:`Tradier ${tradierMode}`,
      })
    } catch(e) {
      setScanErr('❌ '+e.message)
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
        `No quote for ${cfg.primary}. Check your Tradier token in ⚙ Settings.`
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
        const chgPct_=parseFloat(quote.change_percentage||0)
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

      const chgPct=parseFloat(quote.change_percentage||0)
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

  // ─── Alert builder helpers ────────────────────────────────────────────────
  const buildTgAlert = a=>{
    const em={Call:'🟢📈',Put:'🔴📉','Call Spread':'🟢📐','Put Spread':'🔴📐','Iron Condor':'🦅⚖️',Strangle:'🔀⚖️'}
    return `${em[a.type]||'🎯'} *${a.type.toUpperCase()} ALERT*

📌 *Ticker:* $${(a.ticker||'—').toUpperCase()}
🗓 *Expiry:* ${a.expiry||'—'}
💰 *Strike:* ${a.strike||'—'}
📊 *Entry:* ${a.entry||'—'}
🎯 *Target:* ${a.target||'—'}
🛑 *Stop:* ${a.stop||'—'}
📏 *Size:* ${a.size||'—'}

📝 *Thesis:* ${a.thesis||'—'}
⚡ *Catalyst:* ${a.catalyst||'—'}
🌊 *Flow:* ${a.flow||'—'}

_Not financial advice. Trade at your own risk._`
  }

  const buildScanAlert = r => {
  const sym    = r.ticker||r.sym||'—'
  const isBear = (r.tradeType||'').toLowerCase().includes('put')||
                 (r.tradeType||'').toLowerCase().includes('bear')
  const em     = isBear?'🔴📉':'🟢📈'
  const legsBlock = r.legsList?.length
    ? `\n🔧 *Legs:*\n${r.legsList.map(l=>'  '+l).join('\n')}`
    : ''
  const blockWarn = r.hardBlocks?.length
    ? `\n🚫 *SKIP FLAGS:*\n${r.hardBlocks.map(b=>'  ⚠ '+b).join('\n')}`
    : ''
  const beBlock = r.breakeven
    ? `\n📊 *Break-even:* $${r.breakeven} (+${r.breakevenPct}% required) · DTE: ${r.dte}`
    : ''
  return `${em} *${(r.tradeType||'OPTION').toUpperCase()} — $${sym}*

🎯 *Conviction: ${r.score}%* | Grade: ${r.grade||'—'}
💰 *Stock:* ${r.price} (${r.chgPct} today)
📌 *Strike:* ${r.strikeStr} | Expiry: ${r.expiryDisplay}

📊 *Entry:* ${r.entry}
🎯 *Target:* ${r.target}
🛑 *Stop:* ${r.stop}${beBlock}${legsBlock}${blockWarn}

📡 *Chain:* IV: ${r.iv} | Δ ${r.delta} | Bid: ${r.bid} | Ask: ${r.ask}

✅ *Why:*
${(r.reasons||[]).map(x=>'• '+x).join('\n')||'• Momentum setup'}

_Options Edge · ${new Date().toLocaleTimeString()} · Not financial advice_`
}

  const pushToAlert = r=>{
    setAlert(p=>({...p,
      ticker: r.ticker||r.sym||p.ticker,
      type:   r.tradeType||p.type,
      expiry: r.expiryDisplay||p.expiry,
      strike: r.strikeStr||p.strike,
      entry:  r.entry||p.entry,
      target: r.target||p.target,
      stop:   r.stop||p.stop,
    }))
    setToolsTab('alert')
    setShowTools(true)
  }

  // ─── Auto scanner ─────────────────────────────────────────────────────────
  const scanOneTicker = useCallback(async (ticker, tf='Swing (21–45 DTE)')=>{
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
      const chgPct=parseFloat(quote.change_percentage||0)
      const optType=chgPct>=0?'call':'put'
      const step=autoStep(price)
      const tgt=optType==='call'?Math.round(price*1.02/step)*step:Math.round(price*0.98/step)*step
      const side=chain.filter(o=>o.option_type===optType)
      if (!side.length) return null
      const best=side.reduce((a,b)=>Math.abs(b.strike-tgt)<Math.abs(a.strike-tgt)?b:a)
      const bid=parseFloat(best.bid||0),ask=parseFloat(best.ask||0),mid=(bid+ask)/2
      if (mid===0) return null
      const iv=best.greeks?.mid_iv||0,delta=best.greeks?.delta||null
      const vol=quote.volume||0,avg=quote.average_volume||vol
      const volRatio=vol/(avg||1)
      const ivPct2=iv*100
      const now2=new Date()
      const etHour2=now2.getHours()+(now2.getMinutes()/60)
      const isMorning2=etHour2<10.0
      const isChasing2=Math.abs(chgPct)>2.0
      const isHighIV2=iv>0.55
      const expDate2=new Date(expiryRaw+'T12:00:00')
      const dte2=Math.round((expDate2-now2)/(1000*60*60*24))

      let score=50; const reasons=[],warnings=[],hardBlocks2=[]
      if(isMorning2){
        warnings.push('Market open — volatile first 30 min, size smaller')
      }
      if(isChasing2){hardBlocks2.push(`Chasing ${chgPct>0?'+':''}${chgPct.toFixed(1)}%`);score=Math.min(score,42)}
      if(isHighIV2){hardBlocks2.push(`High IV ${ivPct2.toFixed(0)}%`);score=Math.min(score,48)}

      if(iv>=0.20&&iv<=0.40){score+=12;reasons.push(`IV ${ivPct2.toFixed(0)}% low`)}
      else if(iv>0.40&&iv<=0.55){score+=6;reasons.push(`IV ${ivPct2.toFixed(0)}% moderate`)}
      else if(iv>0.55){score-=10;warnings.push(`IV ${ivPct2.toFixed(0)}% high`)}

      if(!isMorning2){
        const vCoherent2  = volRatio>=1.5 && Math.abs(chgPct)>=1.0
        const vDiverge2   = volRatio>=3.0 && Math.abs(chgPct)<0.8
        if(vDiverge2){score-=8;warnings.push(`Vol ${volRatio.toFixed(1)}x but only ${chgPct.toFixed(1)}% move — likely roll/distribution`)}
        else if(vCoherent2){score+=12;reasons.push(`Vol ${volRatio.toFixed(1)}x with ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move`)}
        else if(volRatio>=1.5){score+=4;warnings.push(`Vol ${volRatio.toFixed(1)}x but price only ${chgPct.toFixed(1)}%`)}
        else if(volRatio<0.8){score-=8;warnings.push(`Low vol ${volRatio.toFixed(1)}x`)}
      }

      if(!isChasing2&&Math.abs(chgPct)>=1.5){score+=8;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}%`)}
      else if(!isChasing2&&Math.abs(chgPct)>=0.8){score+=4;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}%`)}
      if(delta&&Math.abs(delta)>=0.35&&Math.abs(delta)<=0.55){score+=10;reasons.push(`Delta ${delta.toFixed(2)}`)}
      else if(delta&&Math.abs(delta)>=0.25&&Math.abs(delta)<=0.65){score+=5}
      if(!isMorning2&&(best.volume||0)>500){score+=5;reasons.push(`${best.volume} vol on strike`)}
      if(dte2<14&&iv>0.45){score-=12;warnings.push(`DTE ${dte2} + IV ${ivPct2.toFixed(0)}% crush risk`)}
      else if(dte2>=21&&dte2<=60){score+=5;reasons.push(`${dte2} DTE`)}

      const hasRealSignal2 = Math.abs(chgPct)>=1.5
      if(!hasRealSignal2 && hardBlocks2.length===0){
        score=Math.min(score,72)
        warnings.push('No clear catalyst — confirm direction before alerting')
      }
      if(hardBlocks2.length>0) score=Math.min(score,48)
      score=Math.min(95,Math.max(20,score))
      const expiryDisplay=new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      return {
        ticker,score,tradeType:optType==='call'?'Call':'Put',
        price:fmtP(price),bid:fmtP(bid),ask:fmtP(ask),mid:fmtP(mid),
        iv:fmtPct(iv),delta:delta?delta.toFixed(3):'—',
        volume:best.volume||0,oi:best.open_interest||0,
        expiryDisplay,
        // Auto-scanner always uses naked option (single best strike)
        ...(() => {
          const td = buildNakedResult(chain, price, step, optType, tfCfg2)
          if (!td) return { strikeStr:'—', entry:'—', target:'—', stop:'—', mid:fmtP(mid), legsList:[] }
          return {
            strikeStr: td.strikeStr,
            entry:     td.entry,
            target:    td.target,
            stop:      td.stop,
            mid:       fmtP(td.mid),
            legsList:  [],
            tradeType: td.structureType,
          }
        })(),
        tfLabel:tfCfg2.label, tfBadge:tfCfg2.badge, tfColor:tfCfg2.color,
        grade:score>=80?'A':score>=65?'B':'C',
        chgPct:chgPct.toFixed(2)+'%',
        reasons,warnings,
      }
    } catch { return null }
  },[tradierToken,tradierMode])

  const runAutoScan = useCallback(async()=>{
    if (!tradierToken) return
    // No morning gate — strong setups are valid at open.
    // The scoring engine already adds a warning for volatile open conditions.
    const activeTF = scanTFRef.current  // read live value — not stale closure
    const tfCfgNow = TF_CONFIG[activeTF]||TF_CONFIG['Swing (21–45 DTE)']
    const list=watchlist.split(',').map(t=>t.trim().toUpperCase()).filter(Boolean)
    const shuffle=arr=>[...arr].sort(()=>Math.random()-.5)
    const tickers=list.length?list:shuffle(SP500)
    const ts=new Date().toLocaleTimeString()
    setAutoLog(p=>[`[${ts}] ▶ Scanning ${tickers.length} tickers · ${tfCfgNow.badge} ${tfCfgNow.label} (${activeTF})`,...p.slice(0,99)])
    for (const ticker of tickers) {
      const r=await scanOneTicker(ticker, activeTF)
      const ts2=new Date().toLocaleTimeString()
      if (!r){setAutoLog(p=>[`[${ts2}] $${ticker}: no data`,...p.slice(0,99)]);continue}
      setAutoLog(p=>[`[${ts2}] $${ticker}: ${r.score}% ${r.tradeType} ${r.strikeStr} mid:${r.mid}`,...p.slice(0,99)])
      if (r.score>=minScore) {
        setLastAlert(r)
        if (tgToken&&tgChatId) {
          const res=await sendTelegram(buildScanAlert(r),tgToken,tgChatId)
          setAutoLog(p=>[`[${ts2}] 🚀 $${ticker} ${r.score}% ${r.tradeType} ${r.strikeStr} → TG: ${res.ok?'✅':'❌'+(res.description||'')}`,...p.slice(0,99)])
        } else {
          setAutoLog(p=>[`[${ts2}] 🚀 $${ticker} ${r.score}% hits threshold`,...p.slice(0,99)])
        }
      }
      await new Promise(res=>setTimeout(res,400))
    }
  },[tradierToken,tradierMode,watchlist,minScore,tgToken,tgChatId,scanOneTicker])

  const toggleAuto=()=>{
    if (autoOn) {
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
      runAutoScan()
      autoRef.current=setInterval(runAutoScan,scanFreq*60*1000)
    }
  }
  useEffect(()=>()=>clearInterval(autoRef.current),[])

  // ─── Journal helpers ──────────────────────────────────────────────────────
  const addTrade=()=>{
    if (!newTrade.ticker) return
    const t={...newTrade,id:Date.now()+'',date:newTrade.date||new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
    setTrades(p=>[t,...p])
    setNewTrade({ticker:'',type:'Call',status:'Open',entry:'',exitPrice:'',pnl:'',contracts:'1',expiry:'',date:'',notes:''})
    setShowAdd(false)
  }
  const gradeCol=g=>g==='A+'?C.green:g==='A'?C.green:g==='B'?C.orange:C.red
  const { user }    = useUser()
  const { getToken } = useAuth()
  const openPortal  = async () => {
    try {
      const token = await getToken()
      const res   = await fetch('/api/stripe/portal', { method:'POST', headers:{ Authorization:`Bearer ${token}` } })
      const d     = await res.json()
      if (d.url) window.location.href = d.url
    } catch {}
  }

  // Push a scan result directly into the journal as a paper trade
  const pushToJournal = r => {
    const t = {
      id: Date.now()+'',
      ticker:           r.ticker||r.sym||'',
      type:             r.tradeType||'Call',
      status:           'Open',
      entry:            r.mid||r.entry||'',   // mid price for clean journal display
      exitPrice:        '',
      pnl:              '',
      contracts:        '1',
      expiry:           r.expiryDisplay||'',
      strike:           r.strikeStr||'',
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
    setTrades(p=>[t,...p])
    setTab('backtest')
    setPaperToast(`✅ ${t.ticker} logged as paper trade`)
    setTimeout(()=>setPaperToast(''), 3000)
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
        const chgPct = parseFloat(quote.change_percentage||0)

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
            const iv=best.greeks?.mid_iv||0, delta=best.greeks?.delta||null

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

  // ─── Morning brief via Claude API ─────────────────────────────────────────
  const fetchMorningBrief = useCallback(async()=>{
    setBriefLoading(true); setMorningBrief('')
    try {
      const r = await fetch('/api/morning', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          spxPrice: esBar?.price?.toFixed(2),
          spxChange: esBar?.chgPct?.toFixed(2),
          ndxPrice: nqBar?.price?.toFixed(2),
          ndxChange: nqBar?.chgPct?.toFixed(2),
          apiKey: anthropicKey,
        })
      })
      // Read as text first — Vercel can return HTML error pages on server crashes
      const text = await r.text()
      let d
      try { d = JSON.parse(text) } catch {
        setMorningBrief('❌ Server returned non-JSON response:\n'+text.slice(0,300)+
          '\n\nThis usually means the /api/morning function crashed on Vercel.\n'+
          'Check Vercel → Deployments → Functions logs for details.')
        setBriefLoading(false); return
      }
      setMorningBrief(d.brief || ('❌ '+(d.error||'No content returned')))
    } catch(e) {
      setMorningBrief('❌ Fetch failed: '+e.message+'\n\nCheck that /api/morning.js is deployed.')
    }
    setBriefLoading(false)
  },[esBar,nqBar])

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{background:C.bg,minHeight:'100vh',fontFamily:"'IBM Plex Mono',monospace",color:C.text,paddingBottom:68,transition:'background .25s, color .25s'}}>
      <style>{`
        *{box-sizing:border-box}
        .hv{cursor:pointer;transition:opacity .15s}.hv:hover{opacity:.8}
        .si{animation:si .25s ease}@keyframes si{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .pulse{animation:pu 1.1s infinite}@keyframes pu{0%,100%{opacity:1}50%{opacity:.35}}
        input:focus,textarea:focus,select:focus{outline:none;border-color:#00ff88!important}
        select option{background:#0d1a26}
        .scanrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:5px}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0a1218}::-webkit-scrollbar-thumb{background:#1a3040;border-radius:2px}
      `}</style>

      {/* ═══════════════ STICKY HEADER ═══════════════════════════════════════ */}
      <div style={{position:'sticky',top:0,zIndex:100,background:C.bg,borderBottom:`1px solid ${C.border}`}}>

        {/* App title row */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px 9px'}}>
          <div style={{display:'flex',alignItems:'baseline',gap:8}}>
            <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,letterSpacing:3,color:C.green,lineHeight:1}}>OPTIONS EDGE</span>
            <span style={{fontSize:8,color:C.dim,letterSpacing:2}}>v3.0</span>
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {autoOn && (
              <span style={{fontSize:9,color:C.green,display:'flex',alignItems:'center',gap:4}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:C.green,display:'inline-block',boxShadow:`0 0 7px ${C.green}`}} className="pulse"/>
                AUTO
              </span>
            )}
            {tradierToken && <span style={{fontSize:9,color:C.dim,letterSpacing:1}}>{tradierMode.toUpperCase()}</span>}
            <button className="hv" onClick={()=>setIsDark(p=>!p)} title={isDark?'Switch to light mode':'Switch to dark mode'} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,borderRadius:4,padding:'5px 9px',fontSize:13,cursor:'pointer',lineHeight:1}}>
              {isDark?'☀':'🌙'}
            </button>
            <button className="hv" onClick={()=>{setShowTools(p=>!p);if(!showTools)setToolsTab('settings')}} style={{background:showTools?`${C.green}18`:'transparent',border:`1px solid ${showTools?C.green:C.border}`,color:showTools?C.green:C.dim,borderRadius:4,padding:'5px 11px',fontSize:11,letterSpacing:.5}}>
              {showTools ? '✕ CLOSE' : '⚙ TOOLS'}
            </button>
            {/* User menu */}
            <div style={{position:'relative',display:'flex',alignItems:'center',gap:6}}>
              {user&&(
                <div style={{display:'flex',alignItems:'center',gap:6}}>
                  <div style={{width:26,height:26,borderRadius:'50%',background:`${C.green}20`,border:`1px solid ${C.green}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:C.green,fontWeight:600}}>
                    {(user.firstName||user.primaryEmailAddress?.emailAddress||'U')[0].toUpperCase()}
                  </div>
                  <button className="hv" onClick={openPortal} title="Manage subscription" style={{background:'transparent',border:'none',color:C.dim,fontSize:9,cursor:'pointer',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5,padding:'2px 4px'}}>PRO</button>
                  <SignOutButton><button className="hv" style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,borderRadius:3,padding:'4px 8px',fontSize:9,cursor:'pointer',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5}}>OUT</button></SignOutButton>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* /ES /NQ price bar */}
        <div style={{display:'flex',alignItems:'stretch',borderTop:`1px solid ${C.border}`,background:isDark?'#070c12':'#eef2f7'}}>
          {[
            {sym:esBar?.label||'SPX',data:esBar,color:esBar?.chgPct>=0?C.green:C.red},
            {sym:nqBar?.label||'NDX',data:nqBar,color:nqBar?.chgPct>=0?C.green:C.red},
          ].map(({sym,data,color},i)=>(
            <div key={sym} style={{flex:1,padding:'6px 14px',display:'flex',alignItems:'center',gap:9,borderRight:i===0?`1px solid ${C.border}`:'none'}}>
              <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:2,color:C.dim}}>{sym}</span>
              {data ? (
                <>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1,color:C.text}}>{data.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                  <span style={{fontSize:10,color,fontWeight:600}}>{data.chgPct>=0?'+':''}{data.chgPct.toFixed(2)}%</span>
                  <span style={{fontSize:10,color,opacity:.7}}>({data.chg>=0?'+':''}{data.chg.toFixed(2)})</span>
                </>
              ) : (
                <span style={{fontSize:12,color:C.dim,letterSpacing:1}}>{barLoading?'—':tradierToken?'—':'NO TOKEN'}</span>
              )}
            </div>
          ))}
          <button className="hv" onClick={fetchPriceBar} disabled={barLoading} style={{padding:'0 12px',background:'transparent',border:'none',borderLeft:`1px solid ${C.border}`,color:barLoading?C.dim:C.blue,fontSize:13,cursor:'pointer',minWidth:36}} title="Refresh prices">
            {barLoading?<span className="pulse">·</span>:'↺'}
          </button>
        </div>
      </div>

      {/* ═══════════════ MAIN CONTENT ════════════════════════════════════════ */}
      <div style={{padding:'14px 16px',maxWidth:920,margin:'0 auto'}}>

        {/* ── DASHBOARD TAB ──────────────────────────────────────────────── */}
        {tab==='dash' && (
          <div className="si">

            {/* ── SPX / NDX price cards ── */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              {[
                {sym:esBar?.label||'SPX',data:esBar,label:'S&P 500 Index'},
                {sym:nqBar?.label||'NDX',data:nqBar,label:'Nasdaq 100 Index'},
              ].map(({sym,data,label})=>{
                const up=data?.chgPct>=0
                const bc=data?up?C.green:C.red:C.dim
                return (
                  <div key={sym} style={{background:C.card,border:`1px solid ${data?bc+'40':C.border}`,borderRadius:6,padding:'11px 13px'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}}>
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:2,color:bc}}>{sym}</span>
                      {data && <span style={{fontSize:8,color:bc,border:`1px solid ${bc}40`,padding:'1px 5px',borderRadius:3}}>{up?'▲ BULL':'▼ BEAR'}</span>}
                    </div>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:C.text,letterSpacing:1,lineHeight:1.1}}>
                      {data?data.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}
                    </div>
                    {data && <div style={{fontSize:10,color:bc,marginTop:2}}>{up?'+':''}{data.chgPct.toFixed(2)}% ({data.chg>=0?'+':''}{data.chg.toFixed(2)})</div>}
                    {!data && <div style={{fontSize:9,color:C.dim,marginTop:2}}>{label}</div>}
                  </div>
                )
              })}
            </div>

            {/* ── No token CTA ── */}
            {!esBar && !nqBar && (
              <div style={{background:'#04080e',border:`1px dashed ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
                <div style={{fontSize:10,color:C.blue}}>Add Tradier token in Settings to load live SPX/NDX data</div>
                <button className="hv" onClick={()=>{setToolsTab('settings');setShowTools(true)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:4,fontSize:9,cursor:'pointer',whiteSpace:'nowrap'}}>ADD TOKEN</button>
              </div>
            )}

            {/* ── Market Conviction ── */}
            <div style={{background:C.card,border:`1px solid ${marketConviction?marketConviction.color+'50':C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>MARKET CONVICTION</div>
                <button className="hv" onClick={fetchPriceBar} style={{fontSize:9,color:C.blue,background:'transparent',border:`1px solid ${C.blue}30`,padding:'2px 7px',borderRadius:3,cursor:'pointer'}}>{'↺'} REFRESH</button>
              </div>
              {marketConviction ? (
                <>
                  <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:42,color:marketConviction.color,letterSpacing:1,lineHeight:1}}>{marketConviction.score}%</div>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:marketConviction.color,letterSpacing:2}}>{marketConviction.direction}</div>
                      <div style={{fontSize:10,color:C.dim,marginTop:2}}>
                        SPX {marketConviction.spxChg>=0?'+':''}{marketConviction.spxChg?.toFixed(2)}% {'·'} NDX {marketConviction.ndxChg>=0?'+':''}{marketConviction.ndxChg?.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  <div style={{position:'relative',height:6,background:C.border,borderRadius:3,overflow:'hidden'}}>
                    <div style={{position:'absolute',left:0,top:0,height:'100%',width:marketConviction.score+'%',background:marketConviction.color,borderRadius:3,transition:'width .6s'}}/>
                    <div style={{position:'absolute',left:'50%',top:0,bottom:0,width:1,background:'#2a4a5a'}}/>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:'#2a5060',marginTop:3}}>
                    <span>BEARISH</span><span>NEUTRAL</span><span>BULLISH</span>
                  </div>
                </>
              ) : (
                <div style={{fontSize:11,color:C.dim,textAlign:'center',padding:'8px 0'}}>Fetch market data to see conviction</div>
              )}
            </div>

            {/* ── Index Setups (SPX/NDX alerts) ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>SPX / NDX INDEX SETUPS</div>
                  <div style={{fontSize:9,color:'#2a5060',marginTop:2}}>All timeframes {'·'} sorted by conviction</div>
                </div>
                <button className="hv" onClick={generateIndexAlerts} disabled={indexAlertsLoading||!tradierToken} style={{
                  background:indexAlertsLoading?'transparent':`${C.green}18`,
                  border:`1px solid ${indexAlertsLoading||!tradierToken?C.border:C.green}`,
                  color:indexAlertsLoading||!tradierToken?C.dim:C.green,
                  padding:'6px 12px',borderRadius:4,fontSize:9,letterSpacing:.8,
                  cursor:tradierToken&&!indexAlertsLoading?'pointer':'not-allowed',
                  fontFamily:"'Bebas Neue',sans-serif",
                }}>
                  {indexAlertsLoading?<span className="pulse">SCANNING</span>:'GENERATE'}
                </button>
              </div>
              {indexAlerts.length===0 && !indexAlertsLoading && (
                <div style={{fontSize:10,color:'#2a5060',textAlign:'center',padding:'10px 0'}}>
                  {tradierToken?'Hit GENERATE to scan SPX & NDX across all 4 timeframes':'Add Tradier token first'}
                </div>
              )}
              {indexAlerts.slice(0,6).map((al,i)=>{
                const high=al.score>=90; const midHit=al.score>=75
                const cardC=high?C.green:midHit?C.blue:C.dim
                return (
                  <div key={i} style={{background:'#06101a',border:`1px solid ${cardC}30`,borderRadius:4,padding:'9px 11px',marginBottom:6}}>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:4}}>
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:17,color:cardC,letterSpacing:2}}>{al.sym}</span>
                      <span style={{fontSize:10,color:C.text}}>{al.tradeType} {al.strikeStr}</span>
                      <span style={{fontSize:8,color:al.tfColor,border:`1px solid ${al.tfColor}40`,padding:'1px 5px',borderRadius:2}}>{al.tfBadge} {al.tfLabel}</span>
                      {high&&<span style={{fontSize:8,color:C.green,border:`1px solid ${C.green}40`,padding:'1px 5px',borderRadius:2}}>90%+ HIGH CONVICTION</span>}
                      <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:cardC,marginLeft:'auto'}}>{al.score}%</span>
                    </div>
                    <div style={{display:'flex',gap:10,fontSize:10,color:C.dim,marginBottom:4,flexWrap:'wrap'}}>
                      <span>Entry: <span style={{color:'#8ab0c0'}}>{al.entry}</span></span>
                      <span>Tgt: <span style={{color:C.green}}>{al.target}</span></span>
                      <span>Stp: <span style={{color:C.red}}>{al.stop}</span></span>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                      <span style={{fontSize:9,color:'#3a6070'}}>Exp: {al.expiryDisplay} {'·'} IV: {al.iv} {'·'} Delta: {al.delta}</span>
                      {tgToken&&tgChatId&&(
                        <button className="hv" onClick={async()=>{await sendTelegram(buildScanAlert({...al,ticker:al.sym}),tgToken,tgChatId);setTgStatus('Sent!');setTimeout(()=>setTgStatus(''),3000)}} style={{marginLeft:'auto',background:`${C.blue}18`,border:`1px solid ${C.blue}40`,color:C.blue,padding:'3px 9px',borderRadius:3,fontSize:9,cursor:'pointer'}}>TG</button>
                      )}
                    </div>
                    {al.reasons.length>0&&<div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:5}}>{al.reasons.map((r,j)=><span key={j} style={{fontSize:8,color:cardC,background:`${cardC}10`,padding:'1px 5px',borderRadius:2}}>{r}</span>)}</div>}
                  </div>
                )
              })}
              {tgStatus&&<div style={{fontSize:10,color:C.green,marginTop:4}}>{tgStatus}</div>}
            </div>

            {/* ── Morning Readout ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:9}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>MORNING READOUT</div>
                  <div style={{fontSize:9,color:'#2a5060',marginTop:2}}>Claude AI brief {'·'} premarket news {'·'} key levels</div>
                </div>
                <button className="hv" onClick={fetchMorningBrief} disabled={briefLoading} style={{
                  background:briefLoading?'transparent':`${C.orange}18`,
                  border:`1px solid ${briefLoading?C.border:C.orange}`,
                  color:briefLoading?C.dim:C.orange,
                  padding:'6px 12px',borderRadius:4,fontSize:9,letterSpacing:.8,
                  cursor:briefLoading?'default':'pointer',fontFamily:"'Bebas Neue',sans-serif",
                }}>
                  {briefLoading?<span className="pulse">GENERATING</span>:'GENERATE'}
                </button>
              </div>
              {morningBrief ? (
                <pre style={{fontSize:10,lineHeight:1.85,color:'#8ab0c0',margin:0,whiteSpace:'pre-wrap',wordBreak:'break-word',borderTop:`1px solid ${C.border}`,paddingTop:9,fontFamily:"'IBM Plex Mono',monospace"}}>{morningBrief}</pre>
              ) : (
                <div style={{fontSize:10,color:'#2a5060',textAlign:'center',padding:'8px 0'}}>
                  Set ANTHROPIC_API_KEY in Vercel env vars to enable
                </div>
              )}
            </div>

            {/* ── Checklist ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'11px 13px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:7}}>
                <div style={{fontSize:9,color:C.dim,letterSpacing:2}}>PRE-TRADE CHECKLIST</div>
                <button className="hv" onClick={()=>{setToolsTab('checklist');setShowTools(true)}} style={{fontSize:9,color:C.blue,background:'transparent',border:`1px solid ${C.blue}30`,padding:'2px 7px',borderRadius:3,cursor:'pointer'}}>OPEN</button>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:32,color:clColor,letterSpacing:1,lineHeight:1}}>{clScore}%</div>
                <div>
                  <div style={{fontSize:11,color:clScore>=80?C.green:clScore>=60?C.orange:C.red}}>{clScore>=80?'STRONG SETUP':clScore>=60?'CAUTION':'SKIP THIS TRADE'}</div>
                  <div style={{fontSize:9,color:C.dim,marginTop:1}}>{Object.values(checked).filter(Boolean).length}/{CHECKLIST.length} checks</div>
                </div>
              </div>
              <div style={{width:'100%',height:4,background:C.border,borderRadius:2,overflow:'hidden'}}>
                <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s',borderRadius:2}}/>
              </div>
            </div>

            {/* ── Journal summary ── */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:12}}>
              {[
                {l:'TOTAL P&L',v:(jStats.pnl>=0?'+':'-')+'$'+Math.abs(jStats.pnl).toFixed(0),c:jStats.pnl>=0?C.green:C.red},
                {l:'WIN RATE', v:jStats.wr+'%',c:jStats.wr>=60?C.green:jStats.wr>=45?C.orange:C.red},
                {l:'OPEN',     v:String(jStats.open),c:C.blue},
              ].map((s,i)=>(
                <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'9px 11px'}}>
                  <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── SCAN TAB ────────────────────────────────────────────────────── */}
        {tab==='scan' && (
          <div className="si">
            {!tradierToken && (
              <div style={{background:'#02080e',border:`1px solid ${C.blue}30`,borderRadius:6,padding:'9px 12px',marginBottom:11,fontSize:11,color:'#5a8aaa',lineHeight:1.6}}>
                ℹ️ No token — server-side Tradier token active (Vercel env var). <button onClick={()=>{setToolsTab('settings');setShowTools(true)}} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontSize:11,padding:0,textDecoration:'underline'}}>Add token in Settings</button> to override.
              </div>
            )}

            {/* Timeframe */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:7}}>TIMEFRAME</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {Object.entries(TF_CONFIG).map(([key,cfg])=>{
                  const active=scanTF===key
                  return (
                    <button key={key} className="hv" onClick={()=>{setScanTF(key);setScanResult(null)}} style={{
                      padding:'9px 11px',borderRadius:6,cursor:'pointer',textAlign:'left',
                      background:active?`${cfg.color}18`:C.card,
                      border:`1px solid ${active?cfg.color:C.border}`,
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                        <span style={{fontSize:13}}>{cfg.badge}</span>
                        <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:12,letterSpacing:1.5,color:active?cfg.color:C.text}}>{cfg.label}</span>
                        {active&&<span style={{marginLeft:'auto',fontSize:8,color:cfg.color,border:`1px solid ${cfg.color}`,padding:'1px 4px',borderRadius:2}}>ACTIVE</span>}
                      </div>
                      <div style={{fontSize:10,color:active?cfg.color+'cc':C.dim}}>{cfg.desc}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Ticker + Type */}
            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:9,marginBottom:11}}>
              <div>
                <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>TICKER SYMBOL</div>
                <input value={scanTicker} onChange={e=>{setScanTicker(e.target.value.toUpperCase());setScanResult(null)}}
                  placeholder="NVDA, AAPL, SPY..." onKeyDown={e=>e.key==='Enter'&&runScan()}
                  style={{...iSt,fontSize:20,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:2}}/>
              </div>
              <Field label="Type" value={scanType} onChange={setScanType} options={['Any','Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
            </div>

            <button className="hv" onClick={runScan} disabled={scanning||!scanTicker} style={{
              width:'100%',padding:'13px',borderRadius:6,fontSize:14,letterSpacing:2,cursor:'pointer',
              fontFamily:"'Bebas Neue',sans-serif",marginBottom:12,
              background:scanning?`${C.green}10`:`${C.green}22`,
              border:`1px solid ${scanning||!scanTicker?C.border:C.green}`,
              color:scanning||!scanTicker?C.dim:C.green,
            }}>
              {scanning?<span className="pulse">🔴 FETCHING LIVE DATA — ${scanTicker}...</span>:`🔍 SCAN $${scanTicker||'TICKER'} — LIVE TRADIER DATA`}
            </button>

            {scanErr&&<div style={{background:'#1a0a10',border:`1px solid ${C.red}40`,borderRadius:6,padding:11,color:C.red,fontSize:12,marginBottom:11,lineHeight:1.6}}>{scanErr}</div>}

            {debugLog.length>0&&(
              <div style={{background:'#02080e',border:`1px solid ${C.border}`,borderRadius:6,padding:11,marginBottom:11,maxHeight:140,overflowY:'auto'}}>
                <Lbl>📡 Live Tradier Feed</Lbl>
                {debugLog.map((l,i)=>(
                  <div key={i} style={{fontSize:11,color:l.startsWith('✅')?C.green:l.includes('ERROR')||l.includes('❌')?C.red:'#4a8a9a',fontFamily:'monospace',lineHeight:1.7}}>{l}</div>
                ))}
              </div>
            )}

            {/* ═══ SCAN RESULT CARD ═══════════════════════════════════════════ */}
            {scanResult&&(
              <div className="si">

                {/* ── Header: grade + ticker + structure ── */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:11,flexWrap:'wrap',gap:8}}>
                  <div style={{display:'flex',gap:10,alignItems:'center'}}>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:52,color:gradeCol(scanResult.grade),lineHeight:1,textShadow:`0 0 28px ${gradeCol(scanResult.grade)}55`}}>{scanResult.grade}</div>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:C.text,letterSpacing:2}}>${scanResult.ticker}</div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,color:gradeCol(scanResult.grade),letterSpacing:1.5,marginBottom:1}}>{scanResult.tradeType}</div>
                      <div style={{fontSize:11,color:C.dim}}>Conviction: <span style={{color:scanResult.score>=80?C.green:C.orange,fontWeight:600}}>{scanResult.score}%</span> · {scanResult.confidence}</div>
                      <div style={{display:'inline-flex',alignItems:'center',gap:5,marginTop:3,padding:'2px 6px',borderRadius:3,background:`${scanResult.tfColor}18`,border:`1px solid ${scanResult.tfColor}40`}}>
                        <span style={{fontSize:10}}>{scanResult.tfBadge}</span>
                        <span style={{fontSize:9,color:scanResult.tfColor,letterSpacing:1}}>{scanResult.tfLabel}</span>
                      </div>
                    </div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    <button className="hv" onClick={()=>pushToAlert(scanResult)} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>→ ALERT</button>
                    <button className="hv" onClick={()=>pushToJournal(scanResult)} style={{background:`${C.orange}20`,border:`1px solid ${C.orange}`,color:C.orange,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>📋 PAPER TRADE</button>
                    {tgToken&&tgChatId&&(
                      <button className="hv" onClick={async()=>{const r=await sendTelegram(buildScanAlert(scanResult),tgToken,tgChatId);setTgStatus(r.ok?'✅ Sent!':'❌ '+r.description);setTimeout(()=>setTgStatus(''),4000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>📤 TG</button>
                    )}
                    {tgStatus&&<span style={{fontSize:10,color:C.green}}>{tgStatus}</span>}
                  </div>
                </div>

                {/* ── Hard block banners ── */}
                {scanResult.hardBlocks?.length>0&&(
                  <div style={{marginBottom:11}}>
                    {scanResult.hardBlocks.map((b,i)=>(
                      <div key={i} style={{background:'#1a0408',border:`1px solid ${C.red}60`,borderRadius:5,padding:'9px 13px',marginBottom:5,display:'flex',gap:8,alignItems:'flex-start'}}>
                        <span style={{fontSize:14,flexShrink:0}}>🚫</span>
                        <div>
                          <div style={{fontSize:9,color:C.red,letterSpacing:1.5,marginBottom:2}}>SKIP THIS TRADE</div>
                          <div style={{fontSize:11,color:'#e08080',lineHeight:1.6}}>{b}</div>
                        </div>
                      </div>
                    ))}
                    <div style={{fontSize:9,color:'#5a3040',padding:'4px 8px',borderRadius:3,background:'#0e0406',border:`1px solid ${C.red}30`}}>
                      Hard blocks cap conviction at 48% regardless of other signals. Fix the issue above before entering.
                    </div>
                  </div>
                )}

                {/* ── PRIMARY TRADE BOX: strike + real option prices ── */}
                <div style={{background:isDark?'#030e06':'#f0f9f4',border:`1px solid ${C.green}50`,borderRadius:6,padding:'12px 14px',marginBottom:11}}>
                  <div style={{fontSize:8,color:C.green,letterSpacing:2,marginBottom:8}}>
                    {scanResult.isSpread ? 'SPREAD EXECUTION' : 'OPTION TRADE'}
                    {' — '}{scanResult.tradeType}
                  </div>

                  {/* Strike + Expiry prominently */}
                  <div style={{display:'flex',gap:14,alignItems:'baseline',marginBottom:10,flexWrap:'wrap'}}>
                    <div>
                      <div style={{fontSize:8,color:C.dim,letterSpacing:2,marginBottom:2}}>STRIKE</div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:C.text,letterSpacing:2,lineHeight:1}}>{scanResult.strikeStr}</div>
                    </div>
                    <div>
                      <div style={{fontSize:8,color:C.dim,letterSpacing:2,marginBottom:2}}>EXPIRY</div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.text,letterSpacing:1}}>{scanResult.expiryDisplay}</div>
                    </div>
                    {!scanResult.isSpread&&(
                      <div>
                        <div style={{fontSize:8,color:C.dim,letterSpacing:2,marginBottom:2}}>OPTION PRICE (MID)</div>
                        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:C.green,letterSpacing:1}}>{scanResult.mid}</div>
                      </div>
                    )}
                  </div>

                  {/* Break-even row */}
                  {!scanResult.isSpread&&scanResult.breakeven&&(
                    <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10,padding:'6px 10px',borderRadius:4,background:isDark?'#060c10':'#e8f0f8',border:`1px solid ${C.blue}30`}}>
                      <div>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>BREAK-EVEN AT EXPIRY</div>
                        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:C.blue,letterSpacing:1}}>${scanResult.breakeven}</div>
                      </div>
                      <div style={{width:1,height:28,background:C.border}}/>
                      <div>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>MOVE REQUIRED</div>
                        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:parseFloat(scanResult.breakevenPct)>5?C.red:parseFloat(scanResult.breakevenPct)>3?C.orange:C.green,letterSpacing:1}}>+{scanResult.breakevenPct}%</div>
                      </div>
                      <div style={{width:1,height:28,background:C.border}}/>
                      <div>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>DTE</div>
                        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:scanResult.dte<14?C.red:scanResult.dte<21?C.orange:C.green,letterSpacing:1}}>{scanResult.dte}</div>
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
                          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:f.c}}>{safe(f.v)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{background:'#020810',borderRadius:4,padding:'8px 10px',marginBottom:10,fontSize:9,color:'#4a7a8a',lineHeight:1.5}}>
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
                        <div style={{fontSize:10,color:f.c,fontWeight:600,lineHeight:1.5}}>{f.v}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Legs breakdown (only for spreads) ── */}
                {scanResult.isSpread&&scanResult.legsList?.length>0&&(
                  <div style={{background:'#020c18',border:`1px solid ${C.blue}40`,borderRadius:6,padding:'10px 13px',marginBottom:11}}>
                    <div style={{fontSize:8,color:C.blue,letterSpacing:2,marginBottom:8}}>LEG-BY-LEG EXECUTION</div>
                    {scanResult.legsList.map((leg,i)=>{
                      const isNet  = leg.startsWith('NET')||leg.startsWith('TOTAL')
                      const isBuy  = leg.startsWith('BUY')
                      const isSell = leg.startsWith('SELL')
                      return (
                        <div key={i} style={{
                          display:'flex',alignItems:'flex-start',gap:8,padding:'6px 9px',borderRadius:3,marginBottom:4,
                          background:isNet?'#02080e':isBuy?'#021006':isSell?'#100202':'transparent',
                          border:`1px solid ${isNet?C.blue+'40':isBuy?C.green+'30':isSell?C.red+'30':C.border}`,
                        }}>
                          <span style={{fontSize:11,color:isNet?C.blue:isBuy?C.green:isSell?C.red:C.dim,flexShrink:0,width:16}}>
                            {isNet?'$':isBuy?'↑':isSell?'↓':'·'}
                          </span>
                          <span style={{fontSize:10,color:isNet?C.blue:isBuy?'#8ae0a0':isSell?'#e08080':'#8ab0c0',fontFamily:'monospace',lineHeight:1.7,wordBreak:'break-all'}}>{leg}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* ── Chain stats grid ── */}
                <div style={{background:'#030d18',border:`1px solid ${C.blue}40`,borderRadius:6,padding:11,marginBottom:11}}>
                  <Lbl color={C.blue}>📡 Live Chain — Tradier {tradierMode} · Stock ${scanResult.price} ({scanResult.chgPct})</Lbl>
                  <div className="scanrow">
                    {[
                      {l:'IV',     v:scanResult.iv,     c:C.orange},
                      {l:'DELTA',  v:scanResult.delta,  c:'#c8d8e8'},
                      {l:'THETA',  v:scanResult.theta,  c:C.red},
                      {l:'VOL',    v:scanResult.volume, c:C.dim},
                      {l:'O.I.',   v:scanResult.oi,     c:C.dim},
                      {l:'VOL/AV', v:scanResult.volRatio,c:C.dim},
                    ].map((f,i)=>(
                      <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:'6px 8px'}}>
                        <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:1}}>{f.l}</div>
                        <div style={{fontSize:11,color:f.c,fontWeight:600}}>{safe(f.v)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Why / Warnings ── */}
                {scanResult.reasons?.length>0&&(
                  <Card style={{marginBottom:7}}>
                    <Lbl color={C.green}>✅ SIGNALS</Lbl>
                    {scanResult.reasons.map((r,i)=><div key={i} style={{fontSize:11,color:isDark?'#8ab0c0':'#2a5070',lineHeight:1.7}}>✓ {r}</div>)}
                  </Card>
                )}
                {scanResult.warnings?.length>0&&(
                  <Card color={`${C.orange}40`} style={{marginBottom:7}}>
                    <Lbl color={C.orange}>⚠️ WARNINGS</Lbl>
                    {scanResult.warnings.map((w,i)=><div key={i} style={{fontSize:11,color:isDark?'#c08040':'#7a5020',lineHeight:1.7}}>⚠ {w}</div>)}
                  </Card>
                )}
              </div>
            )}

            {/* ── Auto-scanner section ── */}
            <div style={{marginTop:18,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div>
                  <div style={{fontSize:9,color:autoOn?C.green:C.dim,letterSpacing:2,display:'flex',alignItems:'center',gap:6}}>
                    <span style={{width:6,height:6,borderRadius:'50%',background:autoOn?C.green:C.dim,display:'inline-block',boxShadow:autoOn?`0 0 8px ${C.green}`:'none'}}/>
                    AUTO-SCANNER {autoOn?'ACTIVE':'— OFF'}
                  </div>
                  <div style={{fontSize:9,color:'#2a5a6a',marginTop:2}}>
                    Every {scanFreq} min · {minScore}%+ conviction · {tgToken&&tgChatId?'✅ TG connected':'⚠️ No TG'}
                  </div>
                </div>
                <button className="hv" onClick={toggleAuto} style={{
                  background:autoOn?`${C.red}20`:`${C.green}20`,
                  border:`1px solid ${autoOn?C.red:C.green}`,
                  color:autoOn?C.red:C.green,
                  padding:'8px 18px',borderRadius:4,fontSize:12,letterSpacing:1,cursor:'pointer',
                  fontFamily:"'Bebas Neue',sans-serif",
                }}>{autoOn?'⏹ STOP':'▶ START'}</button>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:9}}>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>MIN CONVICTION</div>
                  <select value={minScore} onChange={e=>setMinScore(Number(e.target.value))} style={iSt}>
                    {[60,70,75,80,85,90,95].map(v=><option key={v} value={v}>{v}%+</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginBottom:4}}>FREQUENCY</div>
                  <select value={scanFreq} onChange={e=>{const f=Number(e.target.value);setScanFreq(f);if(autoOn){clearInterval(autoRef.current);autoRef.current=setInterval(runAutoScan,f*60*1000);setAutoLog(p=>[`[${new Date().toLocaleTimeString()}] ↺ Interval updated → every ${f} min · ${TF_CONFIG[scanTFRef.current]?.label||scanTFRef.current}`,...p.slice(0,99)])}}} style={iSt}>
                    {[1,2,3,5,10,15,20,30,60].map(v=><option key={v} value={v}>Every {v} {v===1?'min':'mins'}</option>)}
                  </select>
                </div>
              </div>

              <Field label="Watchlist (blank = full S&P 500)" value={watchlist} onChange={setWatchlist} placeholder="NVDA,AAPL,MSFT,SPY"/>

              {lastAlert&&(
                <div style={{background:'#020e06',border:`1px solid ${C.green}40`,borderRadius:6,padding:'10px 12px',marginTop:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <Lbl color={C.green}>🚀 LATEST ALERT</Lbl>
                    <div style={{display:'flex',gap:6}}>
                      <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildScanAlert(lastAlert));setAlertCopied(true);setTimeout(()=>setAlertCopied(false),2000)}} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'4px 10px',borderRadius:3,fontSize:9,cursor:'pointer'}}>
                        {alertCopied?'✅ COPIED':'📋 COPY'}
                      </button>
                      {tgToken&&tgChatId&&(
                        <button className="hv" onClick={async()=>{await sendTelegram(buildScanAlert(lastAlert),tgToken,tgChatId);setTgStatus('✅ Sent!');setTimeout(()=>setTgStatus(''),3000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'4px 10px',borderRadius:3,fontSize:9,cursor:'pointer'}}>📤 TG</button>
                      )}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:C.green,letterSpacing:2}}>${lastAlert.ticker}</span>
                    <span style={{fontSize:12,color:C.text}}>{lastAlert.tradeType} {lastAlert.strikeStr}</span>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.green}}>{lastAlert.score}%</span>
                  </div>
                  <div style={{fontSize:10,color:C.dim,marginTop:3}}>Entry: {lastAlert.entry} · Target: {lastAlert.target} · Stop: {lastAlert.stop}</div>
  
                  {tgStatus&&<div style={{fontSize:10,color:C.green,marginTop:4}}>{tgStatus}</div>}
                </div>
              )}

              {autoLog.length>0&&(
                <div style={{background:'#01060b',borderRadius:5,padding:9,maxHeight:160,overflowY:'auto',marginTop:9,border:`1px solid ${C.border}`}}>
                  <Lbl>Scanner Log</Lbl>
                  {autoLog.map((l,i)=>(
                    <div key={i} style={{fontSize:10,color:l.includes('🚀')?C.green:l.includes('❌')?C.red:'#2a5a6a',fontFamily:'monospace',lineHeight:1.8}}>{l}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── JOURNAL TAB ─────────────────────────────────────────────────── */}
        {tab==='journal' && (
          <div className="si">
            {/* Stats row */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:12}}>
              {[
                {l:'TOTAL P&L',v:(jStats.pnl>=0?'+':'-')+'$'+Math.abs(jStats.pnl).toFixed(0),c:jStats.pnl>=0?C.green:C.red},
                {l:'WIN RATE', v:jStats.wr+'%',c:jStats.wr>=60?C.green:jStats.wr>=45?C.orange:C.red},
                {l:'CLOSED',   v:String(jStats.total),c:C.dim},
                {l:'AVG WIN',  v:'+$'+jStats.aw.toFixed(0),c:C.green},
                {l:'AVG LOSS', v:'-$'+jStats.al.toFixed(0),c:C.red},
                {l:'OPEN',     v:String(jStats.open),c:C.blue},
              ].map((s,i)=>(
                <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'10px 12px'}}>
                  <div style={{fontSize:7,color:C.dim,letterSpacing:2,marginBottom:2}}>{s.l}</div>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:s.c,letterSpacing:1}}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* P&L Chart */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:12}}>
              <Lbl>EQUITY CURVE</Lbl>
              <PnLChart trades={trades}/>
            </div>

            {/* Filter + add */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:6}}>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {['All','Open','Closed','Stopped'].map(f=><Pill key={f} label={f} active={jFilter===f} color={C.blue} onClick={()=>setJFilter(f)}/>)}
              </div>
              <button className="hv" onClick={()=>setShowAdd(p=>!p)} style={{background:showAdd?`${C.green}20`:'transparent',border:`1px solid ${showAdd?C.green:C.border}`,color:showAdd?C.green:C.dim,padding:'6px 12px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>+ LOG TRADE</button>
            </div>

            {showAdd&&(
              <Card color={`${C.green}40`} style={{marginBottom:12}}>
                <Lbl color={C.green}>NEW TRADE ENTRY</Lbl>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:7,marginBottom:7}}>
                  <Field label="Ticker" value={newTrade.ticker} onChange={v=>setNewTrade(p=>({...p,ticker:v.toUpperCase()}))} placeholder="NVDA"/>
                  <Field label="Type" value={newTrade.type} onChange={v=>setNewTrade(p=>({...p,type:v}))} options={['Call','Put','Call Spread','Put Spread','Iron Condor','Butterfly','Strangle']}/>
                  <Field label="Status" value={newTrade.status} onChange={v=>setNewTrade(p=>({...p,status:v}))} options={['Open','Closed','Stopped']}/>
                  <Field label="Strike" value={newTrade.strike} onChange={v=>setNewTrade(p=>({...p,strike:v}))} placeholder="$210C"/>
                  <Field label="Expiry" value={newTrade.expiry} onChange={v=>setNewTrade(p=>({...p,expiry:v}))} placeholder="Jun 20 2026"/>
                  <Field label="Date Entered" value={newTrade.date} onChange={v=>setNewTrade(p=>({...p,date:v}))} placeholder="May 27 2026"/>
                  <Field label="Entry $" value={newTrade.entry} onChange={v=>setNewTrade(p=>({...p,entry:v}))} placeholder="$3.50"/>
                  <Field label="Exit $" value={newTrade.exitPrice} onChange={v=>setNewTrade(p=>({...p,exitPrice:v}))} placeholder="$6.50"/>
                  <Field label="P&L $" value={newTrade.pnl} onChange={v=>setNewTrade(p=>({...p,pnl:v}))} placeholder="+320"/>
                  <Field label="Qty" value={newTrade.contracts} onChange={v=>setNewTrade(p=>({...p,contracts:v}))} placeholder="2"/>
                  <Field label="App Conviction %" value={newTrade.conviction} onChange={v=>setNewTrade(p=>({...p,conviction:v}))} placeholder="90"/>
                  <Field label="IV at Entry %" value={newTrade.iv} onChange={v=>setNewTrade(p=>({...p,iv:v}))} placeholder="38"/>
                  <Field label="Stock Move % at Entry" value={newTrade.chgPctAtEntry} onChange={v=>setNewTrade(p=>({...p,chgPctAtEntry:v}))} placeholder="+1.2"/>
                  <Field label="Break-even Move % Req" value={newTrade.breakevenReqPct} onChange={v=>setNewTrade(p=>({...p,breakevenReqPct:v}))} placeholder="4.3"/>
                </div>
                <div style={{marginBottom:8}}>
                  <Field label="Notes" value={newTrade.notes} onChange={v=>setNewTrade(p=>({...p,notes:v}))} placeholder="What worked, what didn't..." rows={2}/>
                </div>
                <div style={{display:'flex',gap:7}}>
                  <button className="hv" onClick={addTrade} style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,padding:'7px 18px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>SAVE</button>
                  <button className="hv" onClick={()=>setShowAdd(false)} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'7px 13px',borderRadius:4,fontSize:10,letterSpacing:1,cursor:'pointer'}}>CANCEL</button>
                </div>
              </Card>
            )}

            {/* Trade list */}
            {(jFilter==='All'?trades:trades.filter(t=>t.status===jFilter)).length===0
              ? <div style={{color:C.dim,fontSize:12,textAlign:'center',padding:24,border:`1px dashed ${C.border}`,borderRadius:6}}>No trades yet. Hit <span style={{color:C.green}}>+ LOG TRADE</span> to start.</div>
              : (jFilter==='All'?trades:trades.filter(t=>t.status===jFilter)).map(t=>{
                  const pnl=parseFloat(t.pnl||0)
                  const stC=t.status==='Open'?C.blue:t.status==='Closed'?C.green:C.red
                  return (
                    <div key={t.id} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${stC}`,borderRadius:4,padding:'10px 13px',marginBottom:6}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:6}}>
                        <div style={{display:'flex',gap:9,alignItems:'center',flexWrap:'wrap'}}>
                          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:C.text,letterSpacing:2}}>${t.ticker}</span>
                          <span style={{fontSize:9,color:stC,border:`1px solid ${stC}40`,padding:'2px 6px',borderRadius:3}}>{t.status.toUpperCase()}</span>
                          <span style={{fontSize:11,color:C.dim}}>{t.type}</span>
                          {t.expiry&&<span style={{fontSize:10,color:C.dim}}>{t.expiry}</span>}
                          {t.date&&<span style={{fontSize:9,color:'#2a4a5a'}}>{t.date}</span>}
                        </div>
                        <div style={{display:'flex',gap:8,alignItems:'center'}}>
                          {t.pnl&&<span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:pnl>=0?C.green:C.red}}>{pnl>=0?'+':'-'}${Math.abs(pnl)}</span>}
                          <button className="hv" onClick={()=>setTrades(p=>p.filter(x=>x.id!==t.id))} style={{background:'transparent',border:'none',color:'#2a4a5a',fontSize:12,cursor:'pointer'}}>✕</button>
                        </div>
                      </div>
                      {(t.entry||t.exitPrice)&&(
                        <div style={{display:'flex',gap:12,marginTop:5,fontSize:11,color:C.dim}}>
                          {t.entry&&<span>Entry: <span style={{color:'#8ab0c0'}}>{t.entry}</span></span>}
                          {t.exitPrice&&<span>Exit: <span style={{color:'#8ab0c0'}}>{t.exitPrice}</span></span>}
                          {t.contracts&&<span>Qty: <span style={{color:'#8ab0c0'}}>{t.contracts}</span></span>}
                        </div>
                      )}
                      {t.notes&&<div style={{marginTop:5,fontSize:11,color:'#4a6a7a',lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:5}}>{t.notes}</div>}
                    </div>
                  )
                })
            }
          </div>
        )}
      </div>

      {/* ═══════════════ BACKTEST TAB ══════════════════════════════════════════ */}
      {tab==='backtest' && (
        <div className="si">
          {(()=>{
            // ── derive all analytics from trades array ─────────────────────
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
            const beReq     = t=>parseFloat(t.breakevenReqPct||0)
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
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:C.text,letterSpacing:3,lineHeight:1}}>STRATEGY BACKTEST</div>
                  <div style={{fontSize:10,color:C.dim,marginTop:2}}>Based on trades logged in your Journal · tap 📋 PAPER TRADE on any scan result to track it here</div>
                </div>

                {closed.length===0 ? (
                  <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:6,padding:24,textAlign:'center'}}>
                    <div style={{fontSize:13,color:C.dim,marginBottom:8}}>No closed trades yet</div>
                    <div style={{fontSize:11,color:'#3a5a6a',lineHeight:1.8}}>
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
                          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:s.c}}>{s.v}</div>
                        </div>
                      ))}
                    </div>

                    {/* ── Filter impact: blocked vs passed ── */}
                    {(blocked.length>0||passed.length>0)&&(
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:14}}>
                        <div style={{fontSize:9,color:C.dim,letterSpacing:2,marginBottom:10}}>NEW FILTER IMPACT ANALYSIS</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                          <div style={{background:isDark?'#100205':'#fff0f2',border:`1px solid ${C.red}40`,borderRadius:5,padding:'10px 12px'}}>
                            <div style={{fontSize:9,color:C.red,letterSpacing:1.5,marginBottom:4}}>🚫 WOULD HAVE BLOCKED</div>
                            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:C.red}}>{blocked.length}</div>
                            <div style={{fontSize:10,color:C.dim,marginTop:2}}>trades match skip criteria</div>
                            {blockedWr!==null&&<div style={{fontSize:11,color:C.red,marginTop:4}}>Actual win rate: <strong>{blockedWr}%</strong></div>}
                            <div style={{fontSize:11,color:C.dim,marginTop:1}}>P&L if skipped: <span style={{color:totPL(blocked)<=0?C.green:C.red}}>{totPL(blocked)<=0?'Saved':'Lost'} ${Math.abs(totPL(blocked)).toFixed(0)}</span></div>
                          </div>
                          <div style={{background:isDark?'#020e06':'#f0fff4',border:`1px solid ${C.green}40`,borderRadius:5,padding:'10px 12px'}}>
                            <div style={{fontSize:9,color:C.green,letterSpacing:1.5,marginBottom:4}}>✅ PASSES ALL FILTERS</div>
                            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:C.green}}>{passed.length}</div>
                            <div style={{fontSize:10,color:C.dim,marginTop:2}}>clean setups</div>
                            {passedWr!==null&&<div style={{fontSize:11,color:C.green,marginTop:4}}>Win rate: <strong>{passedWr}%</strong></div>}
                            <div style={{fontSize:11,color:C.dim,marginTop:1}}>P&L: <span style={{color:totPL(passed)>=0?C.green:C.red}}>${totPL(passed).toFixed(0)}</span></div>
                          </div>
                        </div>
                        {blocked.length>0&&(
                          <div style={{fontSize:9,color:C.dim,lineHeight:1.8}}>
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
                        <div style={{fontSize:9,color:C.dim,letterSpacing:2,marginBottom:10}}>WIN RATE BY CONVICTION BAND</div>
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
                                <div style={{fontSize:9,color:b.color,letterSpacing:1,marginBottom:2}}>{b.label}</div>
                                <div style={{display:'flex',gap:12,fontSize:10,color:C.dim}}>
                                  <span>{b.arr.length} trades · {w}W/{b.arr.length-w}L</span>
                                  <span style={{color:bPL>=0?C.green:C.red}}>{bPL>=0?'+':''}{bPL.toFixed(0)} P&L</span>
                                </div>
                              </div>
                              <div style={{textAlign:'right'}}>
                                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,color:bWr>=60?C.green:bWr>=45?C.orange:C.red,lineHeight:1}}>{bWr}%</div>
                                <div style={{fontSize:8,color:C.dim}}>win rate</div>
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
                        <div style={{fontSize:9,color:C.dim,letterSpacing:2,marginBottom:10}}>OUTCOME BY IV AT ENTRY</div>
                        {[
                          {label:'Low IV  (<40%)',    arr:closed.filter(t=>ivAt(t)>0&&ivAt(t)<40),   color:C.green},
                          {label:'Moderate IV  (40–55%)', arr:closed.filter(t=>ivAt(t)>=40&&ivAt(t)<=55), color:C.orange},
                          {label:'High IV  (>55%)',   arr:closed.filter(t=>ivAt(t)>55),              color:C.red},
                        ].filter(b=>b.arr.length>0).map((b,i)=>{
                          const bWr=wr(b.arr), bPL=totPL(b.arr), w=b.arr.filter(t=>pnl(t)>0).length
                          return (
                            <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:4,marginBottom:5,background:isDark?'#04080e':'#f5f7fa',border:`1px solid ${b.color}30`}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:9,color:b.color,letterSpacing:1,marginBottom:2}}>{b.label}</div>
                                <div style={{fontSize:10,color:C.dim}}>{b.arr.length} trades · {w}W/{b.arr.length-w}L · <span style={{color:bPL>=0?C.green:C.red}}>{bPL>=0?'+':''}{bPL.toFixed(0)}</span></div>
                              </div>
                              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:bWr>=60?C.green:bWr>=45?C.orange:C.red}}>{bWr}%</div>
                            </div>
                          )
                        })}
                        <div style={{fontSize:9,color:'#2a5060',marginTop:6,lineHeight:1.8}}>
                          MSTR lesson: buying high IV (66%) loses even when direction is right, because IV crush overwhelms the premium gain.
                        </div>
                      </div>
                    )}

                    {/* ── Break-even analysis ── */}
                    {closed.filter(t=>beReq(t)>0).length>=2&&(
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:14}}>
                        <div style={{fontSize:9,color:C.dim,letterSpacing:2,marginBottom:10}}>WIN RATE BY BREAK-EVEN MOVE REQUIRED</div>
                        {[
                          {label:'Easy  (<3% move needed)',   arr:closed.filter(t=>beReq(t)>0&&beReq(t)<3),  color:C.green},
                          {label:'Moderate  (3–5% needed)',   arr:closed.filter(t=>beReq(t)>=3&&beReq(t)<=5),color:C.orange},
                          {label:'Hard  (>5% move needed)',   arr:closed.filter(t=>beReq(t)>5),              color:C.red},
                        ].filter(b=>b.arr.length>0).map((b,i)=>{
                          const bWr=wr(b.arr), w=b.arr.filter(t=>pnl(t)>0).length
                          return (
                            <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:4,marginBottom:5,background:isDark?'#04080e':'#f5f7fa',border:`1px solid ${b.color}30`}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:9,color:b.color,letterSpacing:1,marginBottom:2}}>{b.label}</div>
                                <div style={{fontSize:10,color:C.dim}}>{b.arr.length} trades · {w}W/{b.arr.length-w}L</div>
                              </div>
                              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:bWr>=60?C.green:bWr>=45?C.orange:C.red}}>{bWr}%</div>
                            </div>
                          )
                        })}
                        <div style={{fontSize:9,color:'#2a5060',marginTop:6,lineHeight:1.8}}>
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
                          padding:'5px 10px',borderRadius:3,fontSize:10,letterSpacing:.5,cursor:'pointer',
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
                                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.text,letterSpacing:2}}>{t.ticker}</span>
                                  <span style={{fontSize:9,color:stC,border:`1px solid ${stC}40`,padding:'1px 5px',borderRadius:2}}>{t.status}</span>
                                  <span style={{fontSize:10,color:C.dim}}>{t.type}</span>
                                  {t.strike&&<span style={{fontSize:10,color:C.dim}}>{t.strike}</span>}
                                  {t.expiry&&<span style={{fontSize:9,color:'#2a4a5a'}}>{t.expiry}</span>}
                                  {t.conviction&&<span style={{fontSize:9,color:C.blue,border:`1px solid ${C.blue}30`,padding:'1px 5px',borderRadius:2}}>{t.conviction}%</span>}
                                  {blocked_&&<span style={{fontSize:8,color:C.red,border:`1px solid ${C.red}40`,padding:'1px 5px',borderRadius:2}}>🚫 BLOCKED</span>}
                                </div>
                                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                                  {p!==0&&<span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:isWin?C.green:C.red}}>{p>=0?'+':'-'}${Math.abs(p).toFixed(0)}</span>}
                                  {t.status==='Open'&&<span style={{fontSize:9,color:C.orange,border:`1px solid ${C.orange}40`,padding:'1px 5px',borderRadius:2}}>PAPER</span>}
                                </div>
                              </div>
                              <div style={{display:'flex',gap:10,marginTop:5,fontSize:10,color:C.dim,flexWrap:'wrap'}}>
                                {t.entry&&<span>Entry: <span style={{color:'#8ab0c0'}}>{t.entry}</span></span>}
                                {t.exitPrice&&<span>Exit: <span style={{color:'#8ab0c0'}}>{t.exitPrice}</span></span>}
                                {t.iv&&<span>IV: <span style={{color:parseFloat(t.iv)>55?C.red:parseFloat(t.iv)>40?C.orange:C.green}}>{t.iv}%</span></span>}
                                {t.chgPctAtEntry&&<span>Stk Δ: <span style={{color:Math.abs(parseFloat(t.chgPctAtEntry))>2?C.red:'#8ab0c0'}}>{t.chgPctAtEntry}%</span></span>}
                                {t.breakevenReqPct&&<span>BE req: <span style={{color:parseFloat(t.breakevenReqPct)>5?C.red:parseFloat(t.breakevenReqPct)>3?C.orange:C.green}}>+{t.breakevenReqPct}%</span></span>}
                              </div>
                              {t.notes&&<div style={{marginTop:4,fontSize:10,color:'#3a5a6a',lineHeight:1.5}}>{t.notes}</div>}
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
          background:C.green,color:'#000',borderRadius:5,
          padding:'9px 18px',fontSize:11,fontWeight:600,letterSpacing:.5,
          boxShadow:'0 4px 20px rgba(0,255,136,.4)',
          animation:'toastIn .2s ease',whiteSpace:'nowrap',
        }}>{paperToast}</div>
      )}

      {/* ═══════════════ BOTTOM TAB BAR ══════════════════════════════════════ */}
      <div style={{
        position:'fixed',bottom:0,left:0,right:0,zIndex:90,
        background:isDark?'#06090f':'#eef2f7',borderTop:`1px solid ${C.border}`,
        display:'grid',gridTemplateColumns:'1fr 1fr 1fr',
      }}>
        {[
          {id:'dash',     icon:'◈', label:'DASH'},
          {id:'scan',     icon:'⌁', label:'SCAN'},
          {id:'journal',  icon:'≡', label:'JOURNAL'},
          {id:'backtest', icon:'◎', label:'BACKTEST'},
        ].map(t=>{
          const active=tab===t.id
          return (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
              padding:'11px 4px',gap:3,background:'transparent',border:'none',cursor:'pointer',
              borderTop:`2px solid ${active?C.green:'transparent'}`,
              transition:'border-color .2s',
            }}>
              <span style={{fontSize:17,lineHeight:1,color:active?C.green:C.dim}}>{t.icon}</span>
              <span style={{fontSize:9,letterSpacing:.5,fontFamily:"'IBM Plex Mono',monospace",color:active?C.green:C.dim,textTransform:'uppercase'}}>{t.label}</span>
            </button>
          )
        })}
      </div>

      {/* ═══════════════ TOOLS / SETTINGS SLIDE-IN PANEL ════════════════════ */}
      {showTools&&(
        <div style={{position:'fixed',inset:0,zIndex:200}}>
          {/* Backdrop */}
          <div onClick={()=>setShowTools(false)} style={{position:'absolute',inset:0,background:'rgba(0,0,0,.65)'}}/>
          {/* Panel */}
          <div style={{
            position:'absolute',right:0,top:0,bottom:0,
            width:'min(480px,100vw)',
            background:C.bg,borderLeft:`1px solid ${C.border}`,transition:'background .25s',
            display:'flex',flexDirection:'column',
            animation:'slideIn .22s ease',
          }}>
            <style>{`@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>

            {/* Panel header */}
            <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',background:isDark?'#06090f':'#eef2f7',flexShrink:0}}>
              <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:2,color:C.green}}>TOOLS</span>
              <button className="hv" onClick={()=>setShowTools(false)} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'4px 10px',borderRadius:3,fontSize:11,cursor:'pointer'}}>✕ CLOSE</button>
            </div>

            {/* Panel sub-tabs */}
            <div style={{display:'flex',gap:4,padding:'8px 12px',borderBottom:`1px solid ${C.border}`,flexWrap:'wrap',flexShrink:0,background:isDark?'#070c12':'#eef2f7'}}>
              {[
                {id:'settings',l:'Settings'},
                {id:'alert',   l:'Alert'},
                {id:'checklist',l:'Checklist'},
                {id:'strategy',l:'Strategy'},
                {id:'exit',    l:'Exit Rules'},
                {id:'futures', l:'Futures'},
              ].map(t=>(
                <button key={t.id} onClick={()=>setToolsTab(t.id)} style={{
                  padding:'4px 10px',borderRadius:3,fontSize:10,letterSpacing:.5,cursor:'pointer',
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
                  {/* Tradier */}
                  <Card style={{marginBottom:12}}>
                    <Lbl color={C.green}>📡 TRADIER DATA SOURCE</Lbl>
                    <div style={{display:'grid',gap:9,marginBottom:10}}>
                      <Field label="Bearer Token" value={tradierToken} onChange={setTradierToken} placeholder="Paste Tradier token here" type="password"/>
                      <Field label="Mode" value={tradierMode} onChange={setTradierMode} options={['production','sandbox']}/>
                    </div>
                    {tradierToken&&<div style={{fontSize:10,color:C.green}}>✓ Token set — using <strong>{tradierMode}</strong></div>}
                  </Card>

                  {/* Anthropic */}
                  <Card style={{marginBottom:12}}>
                    <Lbl color={C.orange}>🤖 CLAUDE AI — MORNING BRIEF</Lbl>
                    <div style={{background:'#0a0c06',border:`1px solid ${C.orange}30`,borderRadius:4,padding:10,marginBottom:10,fontSize:10,color:'#8a7a50',lineHeight:1.8}}>
                      <strong style={{color:C.orange}}>Option A (recommended):</strong> Set <code style={{color:C.green}}>ANTHROPIC_API_KEY</code> in Vercel → Settings → Environment Variables → redeploy.{' '}
                      <strong style={{color:C.orange}}>Option B (instant):</strong> Paste your key below — stored locally in your browser only.
                    </div>
                    <Field label="Anthropic API Key (claude.ai/settings → API Keys)" value={anthropicKey} onChange={setAnthropicKey} placeholder="sk-ant-api03-..." type="password"/>
                    {anthropicKey&&<div style={{fontSize:10,color:C.green,marginTop:6}}>✓ Key set — Morning Brief will use this key</div>}
                  </Card>

                  {/* Telegram */}
                  <Card style={{marginBottom:12}}>
                    <Lbl color={C.blue}>📱 TELEGRAM AUTO-ALERTS</Lbl>
                    <div style={{background:'#020c14',border:`1px solid ${C.blue}30`,borderRadius:4,padding:10,marginBottom:10,fontSize:10,color:'#5a8aaa',lineHeight:1.8}}>
                      <strong style={{color:C.green}}>Setup:</strong> Telegram → @BotFather → /newbot → copy token. Add bot to channel as admin.
                    </div>
                    <div style={{display:'grid',gap:8,marginBottom:10}}>
                      <Field label="Bot Token" value={tgToken} onChange={setTgToken} placeholder="7123456789:AAFxxx" type="password"/>
                      <Field label="Chat ID or @ChannelName" value={tgChatId} onChange={setTgChatId} placeholder="-1001234567890"/>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                      <button className="hv" onClick={async()=>{
                        setTgStatus('sending...')
                        const r=await sendTelegram(`🤖 *OPTIONS EDGE Connected!*\n\nAlerts active at ${minScore}%+ conviction.\n\n_${new Date().toLocaleString()}_`,tgToken,tgChatId)
                        setTgStatus(r.ok?'✅ Message sent!':'❌ Failed: '+(r.description||r.error||'check token'))
                        setTimeout(()=>setTgStatus(''),5000)
                      }} disabled={!tgToken||!tgChatId} style={{background:tgToken&&tgChatId?`${C.blue}20`:'transparent',border:`1px solid ${tgToken&&tgChatId?C.blue:C.border}`,color:tgToken&&tgChatId?C.blue:C.dim,padding:'7px 16px',borderRadius:4,fontSize:10,letterSpacing:.8,cursor:tgToken&&tgChatId?'pointer':'not-allowed'}}>
                        📤 SEND TEST
                      </button>
                      {tgStatus&&<span style={{fontSize:11,color:tgStatus.startsWith('✅')?C.green:C.red}}>{tgStatus}</span>}
                    </div>
                  </Card>
                </div>
              )}

              {/* ── ALERT BUILDER ── */}
              {toolsTab==='alert'&&(
                <div className="si">
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                    <Field label="Trade Type" value={alert.type} onChange={v=>setAlert(p=>({...p,type:v}))} options={['Call','Put','Call Spread','Put Spread','Iron Condor','Strangle']}/>
                    <Field label="Ticker" value={alert.ticker} onChange={v=>setAlert(p=>({...p,ticker:v.toUpperCase()}))} placeholder="NVDA"/>
                    <Field label="Expiry" value={alert.expiry} onChange={v=>setAlert(p=>({...p,expiry:v}))} placeholder="May 16 2026"/>
                    <Field label="Strike" value={alert.strike} onChange={v=>setAlert(p=>({...p,strike:v}))} placeholder="210C"/>
                    <Field label="Entry" value={alert.entry} onChange={v=>setAlert(p=>({...p,entry:v}))} placeholder="$3.50 – $3.80"/>
                    <Field label="Target" value={alert.target} onChange={v=>setAlert(p=>({...p,target:v}))} placeholder="$6.50 (+85%)"/>
                    <Field label="Stop Loss" value={alert.stop} onChange={v=>setAlert(p=>({...p,stop:v}))} placeholder="$1.75 (-50%)"/>
                    <Field label="Size" value={alert.size} onChange={v=>setAlert(p=>({...p,size:v}))} placeholder="1–3 contracts"/>
                  </div>
                  <div style={{display:'grid',gap:8,marginBottom:12}}>
                    <Field label="Trade Thesis" value={alert.thesis} onChange={v=>setAlert(p=>({...p,thesis:v}))} placeholder="Why you're entering..." rows={2}/>
                    <Field label="Catalyst" value={alert.catalyst} onChange={v=>setAlert(p=>({...p,catalyst:v}))} placeholder="Earnings, breakout..." rows={1}/>
                    <Field label="Options Flow" value={alert.flow} onChange={v=>setAlert(p=>({...p,flow:v}))} placeholder="Unusual sweeps..." rows={1}/>
                  </div>
                  <Card color={C.border} style={{background:'#050c14'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:9}}>
                      <Lbl>📱 Preview</Lbl>
                      <div style={{display:'flex',gap:6}}>
                        <button className="hv" onClick={()=>{navigator.clipboard.writeText(buildTgAlert(alert));setCopied(true);setTimeout(()=>setCopied(false),2000)}} style={{background:copied?`${C.green}20`:'transparent',border:`1px solid ${copied?C.green:C.border}`,color:copied?C.green:C.dim,padding:'5px 11px',borderRadius:3,fontSize:9,cursor:'pointer'}}>
                          {copied?'✅ COPIED':'📋 COPY'}
                        </button>
                        {tgToken&&tgChatId&&(
                          <button className="hv" onClick={async()=>{const r=await sendTelegram(buildTgAlert(alert),tgToken,tgChatId);setTgStatus(r.ok?'✅ Sent!':'❌ '+r.description);setTimeout(()=>setTgStatus(''),4000)}} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'5px 11px',borderRadius:3,fontSize:9,cursor:'pointer'}}>📤 SEND</button>
                        )}
                      </div>
                    </div>
                    {tgStatus&&<div style={{fontSize:10,color:C.green,marginBottom:7}}>{tgStatus}</div>}
                    <pre style={{fontSize:10,lineHeight:1.8,color:'#8ab0c0',margin:0,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{buildTgAlert(alert)}</pre>
                  </Card>
                </div>
              )}

              {/* ── CHECKLIST ── */}
              {toolsTab==='checklist'&&(
                <div className="si">
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
                    <div>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:clColor,letterSpacing:2}}>
                        {clScore}% — {clScore>=80?'STRONG SETUP 🔥':clScore>=60?'CAUTION ⚠️':'SKIP ❌'}
                      </div>
                      <div style={{fontSize:10,color:C.dim}}>{Object.values(checked).filter(Boolean).length} of {CHECKLIST.length} met</div>
                    </div>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <div style={{width:70,height:5,background:C.border,borderRadius:3,overflow:'hidden'}}>
                        <div style={{width:clScore+'%',height:'100%',background:clColor,transition:'width .4s'}}/>
                      </div>
                      <button className="hv" onClick={()=>setChecked({})} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'4px 9px',borderRadius:3,fontSize:9,cursor:'pointer'}}>RESET</button>
                    </div>
                  </div>
                  {['TA','Flow','News','Risk'].map(cat=>(
                    <div key={cat} style={{marginBottom:13}}>
                      <div style={{fontSize:9,letterSpacing:2,color:CAT_COLOR[cat],marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
                        <span style={{display:'inline-block',width:12,height:1.5,background:CAT_COLOR[cat]}}/>
                        {cat==='TA'?'TECHNICAL':cat==='Flow'?'OPTIONS FLOW':cat==='News'?'NEWS / CATALYST':'RISK MGMT'}
                      </div>
                      {CHECKLIST.filter(i=>i.cat===cat).map(item=>(
                        <div key={item.id} className="hv" onClick={()=>setChecked(p=>({...p,[item.id]:!p[item.id]}))}
                          style={{display:'flex',gap:9,padding:'7px 10px',borderRadius:4,marginBottom:4,
                            background:checked[item.id]?`${CAT_COLOR[cat]}0a`:C.card,
                            border:`1px solid ${checked[item.id]?CAT_COLOR[cat]+'40':C.border}`}}>
                          <div style={{width:14,height:14,borderRadius:2,border:`2px solid ${checked[item.id]?CAT_COLOR[cat]:'#2a4a5a'}`,background:checked[item.id]?CAT_COLOR[cat]:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1}}>
                            {checked[item.id]&&<span style={{color:'#000',fontSize:8,fontWeight:700}}>✓</span>}
                          </div>
                          <div>
                            <div style={{fontSize:11,color:checked[item.id]?'#c8d8e8':'#8ab0c0'}}>{item.l}</div>
                            <div style={{fontSize:10,color:'#3a5a6a',marginTop:1}}>{item.d}</div>
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
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:s.c,letterSpacing:2,marginBottom:6}}>{s.t}</div>
                      {s.rules.map((r,j)=>(
                        <div key={j} style={{display:'flex',gap:8,marginBottom:4,fontSize:11,color:'#8ab0c0'}}>
                          <span style={{color:s.c,flexShrink:0}}>→</span>{r}
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{background:'#050c14',border:`1px dashed ${C.border}`,borderRadius:4,padding:11,fontSize:11,color:'#6a9aaa',lineHeight:1.7}}>
                    <span style={{fontSize:9,color:C.dim,letterSpacing:2}}>GOLDEN RULE — </span>
                    Require <span style={{color:C.green}}>2+ TA</span> + <span style={{color:C.blue}}>1 flow</span> or <span style={{color:C.orange}}>1 catalyst</span> before entry.
                  </div>
                </div>
              )}

              {/* ── EXIT RULES ── */}
              {toolsTab==='exit'&&(
                <div className="si">
                  {EXIT_RULES.map((sec,i)=>(
                    <div key={i} style={{marginBottom:16}}>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:sec.color,letterSpacing:2,marginBottom:7}}>{sec.type}</div>
                      {sec.rules.map((r,j)=>(
                        <div key={j} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${sec.color}`,borderRadius:4,padding:'8px 12px',display:'grid',gridTemplateColumns:'100px 1fr',gap:8,alignItems:'center',marginBottom:4}}>
                          <span style={{fontSize:9,color:sec.color,letterSpacing:.8,fontWeight:600}}>{r.tr.toUpperCase()}</span>
                          <span style={{fontSize:11,color:'#8ab0c0',lineHeight:1.5}}>{r.a}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <Card color={`${C.red}50`}>
                    <Lbl color={C.red}>⚠️ CARDINAL RULES</Lbl>
                    {['Never widen your stop to give it more room','If unsure whether to exit — exit. Re-enter later','Always post exits to your Telegram channel','Partial exits: book 50% at target, trail the rest'].map((r,i)=>(
                      <div key={i} style={{display:'flex',gap:7,marginBottom:4,fontSize:11,color:'#8ab0c0'}}>
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
                        fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:1.5,
                        border:`1px solid ${futSym===sym?C.green:C.border}`,
                        color:futSym===sym?C.green:C.dim,
                        background:futSym===sym?`${C.green}18`:C.card,
                      }}>
                        <div>{cfg.display}</div>
                        <div style={{fontSize:8,fontFamily:"'IBM Plex Mono',monospace",opacity:.6,marginTop:1}}>{cfg.name.split('—')[1]?.trim()||''}</div>
                      </button>
                    ))}
                  </div>

                  <button className="hv" onClick={()=>fetchFutures(futSym)} disabled={futLoading} style={{
                    width:'100%',padding:'11px',borderRadius:5,fontSize:12,letterSpacing:2,
                    fontFamily:"'Bebas Neue',sans-serif",marginBottom:10,cursor:'pointer',
                    background:futLoading?`${C.blue}10`:`${C.blue}22`,
                    border:`1px solid ${futLoading?C.border:C.blue}`,
                    color:futLoading?C.dim:C.blue,
                  }}>
                    {futLoading?<span className="pulse">🔴 FETCHING {FUT_SYMBOLS[futSym]?.display}...</span>:`📡 FETCH ${futSym} — ${FUT_SYMBOLS[futSym]?.name}`}
                  </button>

                  {futErr&&(
                    <div style={{background:'#1a0a10',border:`1px solid ${C.red}40`,borderRadius:5,padding:10,marginBottom:10,lineHeight:1.6}}>
                      <div style={{color:C.red,fontSize:11,marginBottom:5}}>{futErr}</div>
                      <div style={{fontSize:10,color:'#6a3040'}}>
                        <strong style={{color:C.orange}}>Tip:</strong> Futures + index symbols need Tradier production tier.
                        The ETF proxy (SPY/QQQ etc.) always works — it's loaded as final fallback automatically.
                        If all 3 fail, your token is missing or invalid — add it in Settings.
                      </div>
                    </div>
                  )}

                  {futData&&(
                    <div>
                      <div style={{marginBottom:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                          <div>
                            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:C.text,letterSpacing:2}}>
                              {futData.cfg.display} <span style={{fontSize:11,color:futData.usingFutures?C.green:C.orange}}>{futData.usingFutures?'● LIVE':'● INDEX'}</span>
                            </div>
                            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:34,color:futData.biasColor,letterSpacing:1}}>${futData.price.toFixed(2)}</div>
                            <div style={{display:'flex',gap:8,alignItems:'center',marginTop:3}}>
                              <span style={{fontSize:12,color:futData.chgPct>=0?C.green:C.red}}>{futData.chgPct>=0?'+':''}{futData.chgPct.toFixed(2)}%</span>
                              <span style={{fontSize:10,color:futData.biasColor,padding:'1px 7px',borderRadius:3,border:`1px solid ${futData.biasColor}40`,background:`${futData.biasColor}15`}}>{futData.bias}</span>
                              <span style={{fontSize:9,color:C.dim}}>{futData.fetchedAt}</span>
                            </div>
                          </div>
                          <button className="hv" onClick={()=>fetchFutures(futData.sym)} style={{background:`${C.blue}20`,border:`1px solid ${C.blue}`,color:C.blue,padding:'6px 12px',borderRadius:3,fontSize:9,cursor:'pointer'}}>↺ REFRESH</button>
                        </div>

                        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:10}}>
                          {[
                            {l:'OPEN',  v:'$'+futData.open.toFixed(2),  c:'#c8d8e8'},
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
                          <div style={{background:'#04080d',border:`1px solid ${C.red}40`,borderRadius:5,padding:11}}>
                            <Lbl color={C.red}>🔴 RESISTANCE</Lbl>
                            {futData.resistance.length===0
                              ?<div style={{fontSize:11,color:C.dim}}>None found</div>
                              :futData.resistance.map((lvl,i)=>(
                                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<futData.resistance.length-1?`1px solid ${C.border}`:'none'}}>
                                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:C.red}}>${lvl.toFixed(2)}</span>
                                  <span style={{fontSize:9,color:C.dim}}>{((lvl/futData.price-1)*100).toFixed(1)}%</span>
                                </div>
                              ))
                            }
                          </div>
                          <div style={{background:'#020d06',border:`1px solid ${C.green}40`,borderRadius:5,padding:11}}>
                            <Lbl color={C.green}>🟢 SUPPORT</Lbl>
                            {futData.support.length===0
                              ?<div style={{fontSize:11,color:C.dim}}>None found</div>
                              :futData.support.map((lvl,i)=>(
                                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<futData.support.length-1?`1px solid ${C.border}`:'none'}}>
                                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:C.green}}>${lvl.toFixed(2)}</span>
                                  <span style={{fontSize:9,color:C.dim}}>{(((lvl/futData.price)-1)*100).toFixed(1)}%</span>
                                </div>
                              ))
                            }
                          </div>
                        </div>

                        {futData.tradeSetups.length>0&&(
                          <div>
                            <Lbl>TRADE SETUPS</Lbl>
                            {futData.tradeSetups.map((s,i)=>(
                              <div key={i} style={{background:C.card,border:`1px solid ${s.color}40`,borderRadius:5,padding:10,marginBottom:7}}>
                                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                                  <div style={{display:'flex',gap:7,alignItems:'center'}}>
                                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:s.color,letterSpacing:1}}>{s.type}</span>
                                    <span style={{fontSize:11,color:C.text}}>{s.strike}</span>
                                    <span style={{fontSize:9,color:s.color,border:`1px solid ${s.color}40`,padding:'1px 5px',borderRadius:2}}>{s.conviction}</span>
                                  </div>
                                </div>
                                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4}}>
                                  {[
                                    {l:'ENTRY',v:s.entry,c:C.blue},
                                    {l:'TARGET',v:s.target,c:C.green},
                                    {l:'STOP',v:s.stop,c:C.red},
                                  ].map((f,j)=>(
                                    <div key={j} style={{background:'#06101a',borderRadius:3,padding:'5px 7px'}}>
                                      <div style={{fontSize:7,color:C.dim,letterSpacing:1.5,marginBottom:1}}>{f.l}</div>
                                      <div style={{fontSize:10,color:f.c,fontWeight:600}}>{f.v}</div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{display:'flex',gap:12,marginTop:6,fontSize:10,color:C.dim}}>
                                  <span>IV: <span style={{color:'#8ab0c0'}}>{s.iv}</span></span>
                                  <span>Δ: <span style={{color:'#8ab0c0'}}>{s.delta}</span></span>
                                  <span>OI: <span style={{color:'#8ab0c0'}}>{s.oi.toLocaleString()}</span></span>
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
    </div>
  )
}
