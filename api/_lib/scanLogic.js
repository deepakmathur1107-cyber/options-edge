// api/_lib/scanLogic.js
//
// Ported from src/App.jsx (buildNakedResult, scanOneTicker, and their helpers).
// This is the SAME scoring logic the manual scan and old client-side auto-scanner
// use — relocated here so the server-side cron (api/cron/scan.js) can run it
// without a browser, and so there is exactly one implementation instead of
// logic drifting between client and server over time.
//
// IMPORTANT: if you change scoring rules in src/App.jsx's scanOneTicker, mirror
// the change here too (or, longer-term, refactor the frontend to call a shared
// npm-style module — not done yet to avoid a bigger rewrite while this ships).

const autoStep = p => p<25?.5:p<50?1:p<100?2:p<250?5:p<500?10:p<1000?20:50;
const fmtP   = n => n==null?'—':'$'+parseFloat(n).toFixed(2);
const fmtPct = n => n==null?'—':(parseFloat(n)*100).toFixed(1)+'%';

function getETHour() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() + et.getMinutes()/60;
}
function isOpeningWindow() { return getETHour() < 10.0; } // first 30 min ET

const TF_CONFIG = {
  'Quick (5–14 DTE)': {
    minDTE:5,   maxDTE:14,  strikePct:1.02, profitTarget:0.50, stopLoss:0.50,
    label:'Quick Play', badge:'⚡',
  },
  'Swing (21–45 DTE)': {
    minDTE:21,  maxDTE:45,  strikePct:1.02, profitTarget:0.80, stopLoss:0.50,
    label:'Swing Trade', badge:'📈',
  },
  'LEAP (90–180 DTE)': {
    minDTE:90,  maxDTE:180, strikePct:1.05, profitTarget:1.00, stopLoss:0.40,
    label:'LEAP Option', badge:'🏔️',
  },
  'Deep LEAP (180–365 DTE)': {
    minDTE:180, maxDTE:365, strikePct:1.08, profitTarget:1.50, stopLoss:0.35,
    label:'Deep LEAP', badge:'🚀',
  },
};

const pickExpiry = (dates, minDTE, maxDTE) => {
  const now = new Date(); now.setHours(0,0,0,0);
  const withDTE = dates.map(d => {
    const exp = new Date(d+'T12:00:00');
    const dte = Math.round((exp-now)/(1000*60*60*24));
    return {date:d, dte};
  }).filter(x=>x.dte>0);
  const inRange = withDTE.filter(x=>x.dte>=minDTE && x.dte<=maxDTE);
  if (inRange.length) return inRange[0].date;
  const mid=(minDTE+maxDTE)/2;
  return withDTE.reduce((best,x)=>Math.abs(x.dte-mid)<Math.abs(best.dte-mid)?x:best, withDTE[0]).date;
};

const findLeg = (arr, tgt) =>
  arr.length ? arr.reduce((a,b)=>Math.abs(b.strike-tgt)<Math.abs(a.strike-tgt)?b:a) : null;

const approxGEX = (o, price) => {
  const oi    = parseFloat(o.open_interest||0);
  // Same 'NaN'-string-is-truthy trap as buildNakedResult's iv field — validate
  // explicitly rather than relying on || to catch a non-numeric Tradier value.
  const ivRaw = parseFloat(o.greeks?.mid_iv);
  const ivRaw2 = parseFloat(o.implied_volatility);
  const iv    = (!isNaN(ivRaw)&&ivRaw>0) ? ivRaw : (!isNaN(ivRaw2)&&ivRaw2>0) ? ivRaw2 : 0.3;
  const delta = Math.abs(parseFloat(o.greeks?.delta||0.5));
  if (!oi || iv===0) return 0;
  const gammaPx = delta*(1-delta) / (price * iv * Math.sqrt(30/365));
  const sign = o.option_type==='call' ? 1 : -1;
  return sign * gammaPx * oi * 100;
};

const scoreStrike = (o, price, allOI, allVol) => {
  if (!o) return 0;
  const oi      = parseFloat(o.open_interest||0);
  const vol     = parseFloat(o.volume||0);
  const delta   = Math.abs(parseFloat(o.greeks?.delta||0));
  const bid     = parseFloat(o.bid||0);
  const ask     = parseFloat(o.ask||0);
  const mid     = (bid+ask)/2;
  if (mid === 0 || bid === 0) return 0;
  const oiScore  = allOI  > 0 ? oi  / allOI  : 0;
  const volScore = allVol > 0 ? vol / allVol  : 0;
  const dScore = delta>=0.30 && delta<=0.55 ? 1.0
               : delta>=0.20 && delta<=0.65 ? 0.6
               : delta>=0.10                ? 0.2 : 0;
  const spread = ask > 0 ? (ask-bid)/ask : 1;
  const liqPen = 1 - Math.min(spread, 0.5)*0.6;
  const gex     = Math.abs(approxGEX(o, price));
  const gexNorm = Math.min(gex / (allOI * 0.01 + 1), 1);
  return (oiScore*0.35 + volScore*0.30 + dScore*0.25 + gexNorm*0.10) * liqPen;
};

const findBestStrike = (side, tgtStrike, price) => {
  if (!side.length) return null;
  const allOI  = Math.max(...side.map(o=>parseFloat(o.open_interest||0)), 1);
  const allVol = Math.max(...side.map(o=>parseFloat(o.volume||0)), 1);
  const step   = autoStep(price);
  const candidates = side.filter(o=>Math.abs(o.strike-tgtStrike)<=step*3);
  const pool = candidates.length ? candidates : side;
  const scored = pool.map(o=>({o, s:scoreStrike(o, price, allOI, allVol)}))
                      .filter(x=>x.s>0)
                      .sort((a,b)=>b.s-a.s);
  if (scored.length) return scored[0].o;
  return findLeg(side, tgtStrike);
};

const findGEXWall = (side, price, direction) => {
  const filtered = direction==='above' ? side.filter(o=>o.strike>price)
                  : direction==='below' ? side.filter(o=>o.strike<price)
                  : side;
  if (!filtered.length) return null;
  return filtered.reduce((a,b)=>Math.abs(approxGEX(b,price))>Math.abs(approxGEX(a,price))?b:a);
};

// buildNakedResult: select the best single-leg contract for a directional bet.
const buildNakedResult = (chain, price, step, optType, tfCfg) => {
  const side = chain.filter(o=>o.option_type===optType);
  if (!side.length) return null;
  const pct = optType==='call' ? tfCfg.strikePct : (2-tfCfg.strikePct);
  const tgtStrike = Math.round(price*pct/step)*step;
  const best = findBestStrike(side, tgtStrike, price);
  if (!best) return null;
  const b = Math.max(0,parseFloat(best.bid||0));
  const a = Math.max(0,parseFloat(best.ask||0));
  const m = (b+a)/2;
  if (m<=0) return null;
  const f2 = v => Math.max(0,v).toFixed(2);
  const allOI  = Math.max(...side.map(o=>parseFloat(o.open_interest||0)), 1);
  const allVol = Math.max(...side.map(o=>parseFloat(o.volume||0)), 1);
  const sc = scoreStrike(best, price, allOI, allVol);
  const gex = approxGEX(best, price);
  const suf  = optType==='call' ? 'C' : 'P';
  return {
    strikeStr:     `$${best.strike}${suf}`,
    bid:b, ask:a, mid:m,
    entry:         `$${f2(m*0.95)} – $${f2(m*1.05)}  (mid $${f2(m)})`,
    target:        `$${f2(m*(1+tfCfg.profitTarget))}  (+${(tfCfg.profitTarget*100).toFixed(0)}%)`,
    stop:          `$${f2(m*(1-tfCfg.stopLoss))}  (−${(tfCfg.stopLoss*100).toFixed(0)}%)`,
    structureType: optType==='call' ? 'Long Call' : 'Long Put',
    legs:          null,
    // Tradier occasionally returns mid_iv as the literal string 'NaN' when its
    // IV solver fails to converge (common pre-market with stale/wide/zero bid-ask).
    // A non-empty string is truthy in JS, so '||0' alone doesn't catch it — must
    // explicitly validate the parsed number isn't NaN before trusting it.
    iv:            (()=>{ const v=parseFloat(best.greeks?.mid_iv); if(!isNaN(v)&&v>0) return v; const v2=parseFloat(best.implied_volatility); return (!isNaN(v2)&&v2>0) ? v2 : 0 })(),
    delta:         best.greeks?.delta||null,
    theta:         best.greeks?.theta||null,
    volume:        best.volume||0,
    oi:            best.open_interest||0,
    primaryStrike: best.strike,
    strikeScore:   sc,
    gexSign:       gex>=0?'positive':'negative',
  };
};

// ─────────────────────────────────────────────────────────────────────────
// scanTicker: server-side port of scanOneTicker. Same scoring, same hard
// blocks, same direction-aware breakeven. Market regime (spxChg/ndxChg) is
// passed in rather than read from React state, since this runs outside React.
// ─────────────────────────────────────────────────────────────────────────
function scanTicker({ ticker, quote, expDates, chain, tf, fund, spxChg, ndxChg }) {
  const tfCfg2 = TF_CONFIG[tf] || TF_CONFIG['Swing (21–45 DTE)'];
  try {
    if (!quote) return null;
    const price = parseFloat(quote.last||quote.prevclose||0);
    if (!price) return null;
    if (!expDates.length) return null;
    const expiryRaw = pickExpiry(expDates, tfCfg2.minDTE, tfCfg2.maxDTE);
    if (!chain.length) return null;

    const chgPct = parseFloat(quote.change_percentage||0);
    const spxDir = spxChg||0;
    const optType = chgPct > 0.1 ? 'call'
                  : chgPct < -0.1 ? 'put'
                  : spxDir >= 0 ? 'call' : 'put';
    const step = autoStep(price);
    const side = chain.filter(o=>o.option_type===optType);
    if (!side.length) return null;

    const td = buildNakedResult(chain, price, step, optType, tfCfg2);
    if (!td) return null;

    const iv = td.iv||0, delta = td.delta||null;
    const vol = quote.volume||0, avg = quote.average_volume||vol;
    const volRatio = vol/(avg||1);
    const ivPct2 = iv*100;
    const now2 = new Date();
    const isMorning2 = isOpeningWindow();
    const isIntraChasing2 = Math.abs(chgPct)>2.0 && Math.abs(chgPct)<=5.0;
    const isEarningsGap2  = Math.abs(chgPct)>5.0;
    const isChasing2      = isIntraChasing2;
    const isHighIV2       = iv>0.55;
    const expDate2 = new Date(expiryRaw+'T12:00:00');
    const dte2 = Math.round((expDate2-now2)/(1000*60*60*24));

    const hi52 = parseFloat(quote.week_52_high||price);
    const lo52 = parseFloat(quote.week_52_low||price);
    const pos52 = (price-lo52)/((hi52-lo52)||1);

    const spxChgToday = spxChg||0;
    const ndxChgToday = ndxChg||0;
    const marketFalling = spxChgToday<-0.5 && ndxChgToday<-0.5;
    const marketRising  = spxChgToday>0.5  && ndxChgToday>0.5;

    let score=50; const reasons=[],warnings=[],hardBlocks2=[];

    if (isMorning2) warnings.push('Market open — volatile first 30 min, size smaller');

    if (isChasing2){hardBlocks2.push(`Chasing ${chgPct>0?'+':''}${chgPct.toFixed(1)}% intraday`);score=Math.min(score,42);}
    if (isHighIV2){hardBlocks2.push(`High IV ${ivPct2.toFixed(0)}%`);score=Math.min(score,48);}

    if (isEarningsGap2){
      const gapOpt = chgPct>0?'call':'put';
      if (optType===gapOpt){
        score+=15;reasons.push(`Earnings/news gap ${chgPct>0?'+':''}${chgPct.toFixed(1)}%`);
        warnings.push('Gap play — size at 50% normal, enter on pullback');
      } else {
        score-=20;warnings.push('Trading against gap — very high risk');
      }
    }

    if (marketFalling && optType==='call'){
      score-=12;warnings.push(`Market headwind — SPX ${spxChgToday.toFixed(1)}% / NDX ${ndxChgToday.toFixed(1)}%`);
    } else if (marketRising && optType==='put'){
      score-=10;warnings.push(`Market headwind — SPX ${spxChgToday.toFixed(1)}% / NDX ${ndxChgToday.toFixed(1)}%`);
    } else if (marketRising && optType==='call'){
      score+=6;reasons.push(`Market tailwind — SPX ${spxChgToday.toFixed(1)}%`);
    } else if (marketFalling && optType==='put'){
      score+=6;reasons.push(`Market tailwind — SPX ${spxChgToday.toFixed(1)}% falling`);
    }

    if (iv>=0.20&&iv<=0.40){score+=12;reasons.push(`IV ${ivPct2.toFixed(0)}% — cheap premium`);}
    else if (iv>0.40&&iv<=0.55){score+=6;reasons.push(`IV ${ivPct2.toFixed(0)}% — moderate`);}
    else if (iv>0.55&&iv<=0.65){score-=8;warnings.push(`IV ${ivPct2.toFixed(0)}% elevated`);}
    else if (iv>0.65){score-=15;warnings.push(`IV ${ivPct2.toFixed(0)}% HIGH — move priced in`);}

    if (!isMorning2){
      const vCoherent2 = volRatio>=1.5 && Math.abs(chgPct)>=1.0;
      const vDiverge2  = volRatio>=3.0 && Math.abs(chgPct)<0.8;
      if (vDiverge2){score-=8;warnings.push(`Vol ${volRatio.toFixed(1)}x but only ${chgPct.toFixed(1)}% — likely roll`);}
      else if (vCoherent2){score+=12;reasons.push(`Vol ${volRatio.toFixed(1)}x with ${chgPct>0?'+':''}${chgPct.toFixed(1)}% move`);}
      else if (volRatio>=1.5){score+=4;warnings.push(`Vol ${volRatio.toFixed(1)}x but price only ${chgPct.toFixed(1)}%`);}
      else if (volRatio<0.8){score-=8;warnings.push(`Low vol ${volRatio.toFixed(1)}x`);}
    }

    if (!isChasing2&&!isEarningsGap2){
      if (Math.abs(chgPct)>=1.5){score+=8;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}%`);}
      else if (Math.abs(chgPct)>=0.8){score+=4;reasons.push(`${chgPct>0?'+':''}${chgPct.toFixed(2)}%`);}
    }

    if (delta&&Math.abs(delta)>=0.35&&Math.abs(delta)<=0.55){score+=10;reasons.push(`Delta ${delta.toFixed(2)} ideal`);}
    else if (delta&&Math.abs(delta)>=0.25&&Math.abs(delta)<=0.65){score+=5;reasons.push(`Delta ${delta.toFixed(2)}`);}

    if (!isMorning2&&(td.volume||0)>500){score+=5;reasons.push(`${td.volume} contracts on strike`);}
    else if (!isMorning2&&(td.volume||0)<50){score-=5;warnings.push(`Only ${td.volume||0} contracts on strike — thin liquidity`);}

    if (optType==='call') {
      if (pos52>0.80){score+=8;reasons.push('Near 52w high — uptrend tailwind');}
      else if (pos52>0.65){score+=4;}
      else if (pos52<0.20){score-=8;warnings.push('Near 52w low — calls against trend');}
    } else {
      if (pos52<0.20){score+=8;reasons.push('Near 52w low — downtrend tailwind for puts');}
      else if (pos52<0.35){score+=4;}
      else if (pos52>0.80){score-=8;warnings.push('Near 52w high — puts against uptrend');}
    }

    if (dte2<14&&iv>0.45){score-=12;warnings.push(`DTE ${dte2} + IV ${ivPct2.toFixed(0)}% crush risk`);}
    else if (dte2>=21&&dte2<=60){score+=5;reasons.push(`${dte2} DTE`);}

    if (td && td.mid>0){
      const strike_ = parseFloat(td.primaryStrike||0);
      if (strike_>0){
        const isPutA = optType==='put';
        const bePrice_a = isPutA ? (strike_ - td.mid) : (strike_ + td.mid);
        const beReq_a = ((bePrice_a / price) - 1) * 100;
        const beAbs_a = Math.abs(beReq_a);
        const beDir_a = isPutA ? 'down' : 'up';
        if (beAbs_a>5.0){score-=14;warnings.push(`Break-even needs ${isPutA?'-':'+'}${beAbs_a.toFixed(1)}% move ${beDir_a} — low probability`);}
        else if (beAbs_a>3.5){score-=7;warnings.push(`Break-even needs ${isPutA?'-':'+'}${beAbs_a.toFixed(1)}% move ${beDir_a} — needs catalyst`);}
        else if (beAbs_a<=2.5&&beAbs_a>0){score+=5;reasons.push(`Break-even only ${isPutA?'-':'+'}${beAbs_a.toFixed(1)}% away`);}
      }
    }

    if (fund){
      if (fund.market_cap && fund.market_cap > 100_000_000_000){
        score+=3;reasons.push(`Large-cap (${fund.sector||'—'})`);
      }
      if (fund.earnings_date){
        const earnDays = Math.round((new Date(fund.earnings_date)-now2)/(1000*60*60*24));
        if (earnDays>=0 && earnDays<=7){
          warnings.push(`⚠️ Earnings in ${earnDays}d — IV crush risk after event`);
          if (!isEarningsGap2) score-=10;
        } else if (earnDays>7 && earnDays<=21){
          warnings.push(`Earnings in ${earnDays}d — factor into DTE choice`);
        }
      }
    }

    const hasRealSignal2 = Math.abs(chgPct)>=1.5 || pos52>0.85 || isEarningsGap2;
    if (!hasRealSignal2 && hardBlocks2.length===0){
      score=Math.min(score,72);
      warnings.push('No clear catalyst — confirm direction before entering');
    }
    if (hardBlocks2.length>0) score=Math.min(score,48);
    score=Math.min(95,Math.max(20,score));

    const expiryDisplay = new Date(expiryRaw+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const isPutReturn = optType === 'put';
    const bePriceReturn = td.primaryStrike
      ? (isPutReturn ? parseFloat(td.primaryStrike) - td.mid : parseFloat(td.primaryStrike) + td.mid)
      : null;
    const breakeven2 = bePriceReturn != null ? bePriceReturn.toFixed(2) : null;
    const breakevenPct2 = bePriceReturn != null && price > 0
      ? (((bePriceReturn / price) - 1) * 100).toFixed(1)
      : null;

    return {
      ticker, score,
      tradeType: td.structureType,
      price:fmtP(price), bid:fmtP(td.bid), ask:fmtP(td.ask), mid:fmtP(td.mid),
      iv:fmtPct(iv), delta:delta?delta.toFixed(3):'—',
      volume:td.volume||0, oi:td.oi||0,
      expiryDisplay,
      strikeStr: td.strikeStr,
      entry:td.entry, target:td.target, stop:td.stop,
      tfLabel:tfCfg2.label, tfBadge:tfCfg2.badge,
      grade: score>=80?'A':score>=65?'B':'C',
      chgPct: chgPct.toFixed(2)+'%',
      reasons, warnings,
      hardBlocks: hardBlocks2,
      dte: dte2,
      breakeven: breakeven2,
      breakevenPct: breakevenPct2,
      hi52: parseFloat(quote.week_52_high||price),
      lo52: parseFloat(quote.week_52_low||price),
      sector:     fund?.sector     || null,
      industry:   fund?.industry   || null,
      marketCap:  fund?.market_cap || null,
      earningsDate: fund?.earnings_date || null,
    };
  } catch { return null; }
}

module.exports = { TF_CONFIG, pickExpiry, buildNakedResult, scanTicker, autoStep, isOpeningWindow };
