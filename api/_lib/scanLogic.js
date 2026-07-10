// api/_lib/scanLogic.js
//
// Ported from src/App.jsx (buildNakedResult, scanOneTicker, and their helpers).
// This is the SAME data-fetching/chain-selection logic the manual scan and
// old client-side auto-scanner use — relocated here so the server-side cron
// (api/cron/scan.js) can run it without a browser.
//
// CONSOLIDATED: the actual scoring math (score+=/-=, hard blocks, caps) used
// to be a third independently-maintained copy in this file, alongside the
// other two in src/App.jsx (runScan, scanOneTicker). All three had already
// drifted — see api/_lib/convictionScore.cjs's header comment for the three
// confirmed divergences this consolidation fixed. Scoring now lives in
// exactly one place (convictionScore.cjs) and is called from here, not
// reimplemented here. If you need to change a scoring rule, change it there
// — never re-add inline score+=/-= logic to this file.

const { scoreConviction, safeIV, pickBetterSide } = require('./convictionScore.cjs');

const autoStep = p => p<25?.5:p<50?1:p<100?2:p<250?5:p<500?10:p<1000?20:50;
const fmtP   = n => n==null?'—':'$'+parseFloat(n).toFixed(2);
const fmtPct = n => n==null?'—':(parseFloat(n)*100).toFixed(1)+'%';

function getETHour() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() + et.getMinutes()/60;
}
function isOpeningWindow() { return getETHour() < 10.0; } // first 30 min ET
function isPreMarket() {
  const now = new Date();
  const dayET = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat', 'Sun'].includes(dayET)) return false;
  const h = getETHour();
  return h >= 4.0 && h < 9.5;
}

// safeChgPct: Tradier's change_percentage (and change/last) only update from the
// regular-session tape — they stay frozen at 0 vs prevclose before 9:30 AM ET no
// matter how far the stock has actually moved in pre-market. NBBO bid/ask, unlike
// last/change, does update pre-market (wider spreads, but live).
//
// FIX: the original version only derived a bid/ask estimate when the reported
// value was EXACTLY 0 — confirmed live to miss real cases. A TSLA scan at
// ~10:00 AM ET (30 min after the open, not pre-market at all) showed an
// 82% conviction Quick Play $400C call after TSLA had already gapped from
// ~$394 to ~$413 (+4.8%, squarely inside the 2–5% chasing band that should
// have capped the score at 42%). That means change_percentage was non-zero
// but still wrong/stale for the chasing check's purposes — trusted at face
// value since the old logic only ever double-checked an exact 0.
//
// Now: always compute the bid/ask-derived estimate as a cross-check, and use
// whichever magnitude is LARGER for anything chasing-related — under-
// detecting a real gap-up costs real money buying into an already-priced-in
// move; over-flagging just skips a trade. Still reports which path was used
// (estimated: true/false/'cross-checked') so callers/logs can tell which
// case triggered.
function safeChgPct(q) {
  const reported = parseFloat(q && q.change_percentage);
  const validReported = !isNaN(reported) ? reported : 0;

  const bid  = parseFloat(q && q.bid);
  const ask  = parseFloat(q && q.ask);
  const prev = parseFloat(q && q.prevclose);
  const hasBidAsk = !isNaN(bid) && !isNaN(ask) && bid>0 && ask>0 && !isNaN(prev) && prev>0;

  if (!hasBidAsk) {
    // No bid/ask to cross-check against — fall back to whatever was
    // reported (matches old behavior for this edge case).
    return { pct: validReported, estimated: false };
  }

  const mid = (bid+ask)/2;
  const bidAskPct = ((mid-prev)/prev)*100;

  if (validReported === 0) {
    // Old exact-zero case — definitely frozen, trust the bid/ask estimate.
    return { pct: bidAskPct, estimated: true };
  }

  // Both values exist and reported isn't exactly 0 — cross-check them. If
  // they're reasonably close, trust the official reported value (it's the
  // real trade tape, more accurate than a bid/ask midpoint when both agree).
  // If they diverge meaningfully, take whichever has the LARGER magnitude —
  // conservative in the direction that matters for the chasing check.
  const diverges = Math.abs(Math.abs(reported) - Math.abs(bidAskPct)) > 1.0
  if (!diverges) return { pct: validReported, estimated: false };
  const useBidAsk = Math.abs(bidAskPct) > Math.abs(validReported);
  return { pct: useBidAsk ? bidAskPct : validReported, estimated: useBidAsk };
}

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

// Returns {date, dte, isFallback}. dte here is the SAME midnight-truncated
// calculation used to pick the expiry — callers that need a dte for storage
// or scoring should reuse this value rather than recomputing one against a
// fresh `new Date()`, which (using current hour/minute) can round to a
// different integer than this function used for in-range filtering, causing
// the stored dte to silently disagree with the dte that drove the bucket
// selection. isFallback is true whenever no listed expiry actually falls
// inside [minDTE, maxDTE] and the closest-to-midpoint expiry was used
// instead — callers MUST propagate this so rows get flagged rather than
// silently mislabeled with a timeframe bucket whose DTE window the picked
// expiry doesn't actually satisfy.
const pickExpiry = (dates, minDTE, maxDTE) => {
  const now = new Date(); now.setHours(0,0,0,0);
  const withDTE = dates.map(d => {
    const exp = new Date(d+'T12:00:00');
    const dte = Math.round((exp-now)/(1000*60*60*24));
    return {date:d, dte};
  }).filter(x=>x.dte>0);
  const inRange = withDTE.filter(x=>x.dte>=minDTE && x.dte<=maxDTE);
  if (inRange.length) return {date: inRange[0].date, dte: inRange[0].dte, isFallback: false};
  const mid=(minDTE+maxDTE)/2;
  const best = withDTE.reduce((best,x)=>Math.abs(x.dte-mid)<Math.abs(best.dte-mid)?x:best, withDTE[0]);
  return {date: best.date, dte: best.dte, isFallback: true};
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

// gexMagnitudeNorm: 0-1 normalized magnitude of approxGEX for ONE contract,
// relative to the actual range of |gex| values across all contracts on that
// side of the chain — NOT a raw-OI-scaled denominator. An earlier version used
// allOI*0.01+1 as the denominator (matching scoreStrike's internal gexNorm),
// but that constant is tuned for scoreStrike's composite where it's damped by
// a 0.10 weight — used standalone, real-world OI (thousands) made the raw gex
// value dwarf that denominator by 100-300x, saturating Math.min(...,1) to 1.0
// for nearly every realistically-selected contract regardless of how it
// actually compared to chain peers. Confirmed via direct calculation before
// shipping: gex≈14,500 vs denom≈51 → ratio≈285, clamped to 1 every time.
// Fixed by normalizing against max(|gex|) actually observed on this side,
// so the result is a genuine relative ranking (0 = lowest-gex contract on
// this side, 1 = highest), not a near-constant ceiling value.
const gexMagnitudeNorm = (o, price, allGexAbsMax) => {
  if (!allGexAbsMax || allGexAbsMax <= 0) return 0;
  const gex = Math.abs(approxGEX(o, price));
  return Math.min(gex / allGexAbsMax, 1);
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
  // Rounded to 2 decimals here, not just in the f2()-formatted display
  // strings below — m itself is returned raw (mid:m) and flows through
  // midRaw into pushToJournal -> trades.entry_price/exit_price as a raw
  // NUMBER, not a display string. Confirmed live: a journaled trade had
  // exit_price = 3.8499999999999996 from this exact unrounded (b+a)/2.
  // Same bug class as the documented formatted-string-vs-raw-number issue,
  // just inverted — the raw value needed rounding, only the display
  // strings (via f2) were getting it.
  const m = Math.round(((b+a)/2) * 100) / 100;
  if (m<=0) return null;
  const f2 = v => Math.max(0,v).toFixed(2);
  const allOI  = Math.max(...side.map(o=>parseFloat(o.open_interest||0)), 1);
  const allVol = Math.max(...side.map(o=>parseFloat(o.volume||0)), 1);
  const sc = scoreStrike(best, price, allOI, allVol);
  const gex = approxGEX(best, price);
  // allGexAbsMax: highest |gex| across THIS side of the chain — used to
  // normalize the selected contract's gex as a genuine relative ranking
  // rather than against a raw-OI-scaled constant that saturates (see
  // gexMagnitudeNorm's comment for why allOI was wrong here).
  const allGexAbsMax = Math.max(...side.map(o=>Math.abs(approxGEX(o, price))), 1);
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
    iv:            safeIV(best),
    delta:         best.greeks?.delta||null,
    theta:         best.greeks?.theta||null,
    volume:        best.volume||0,
    oi:            best.open_interest||0,
    primaryStrike: best.strike,
    strikeScore:   sc,
    gexSign:       gex>=0?'positive':'negative',
    gexMagnitude01: gexMagnitudeNorm(best, price, allGexAbsMax),
  };
};

// ─────────────────────────────────────────────────────────────────────────
// scanTicker: server-side port of scanOneTicker. Same scoring, same hard
// blocks, same direction-aware breakeven. Market regime (spxChg/ndxChg) is
// passed in rather than read from React state, since this runs outside React.
//
// TWO-SIDED SCORING (this pass): previously, optType was decided BEFORE any
// scoring ran (purely from today's chgPct vs. SPX direction as tie-break),
// then every downstream check — IV bands, delta quality, 52w trend, breakeven,
// S/R — only ever ran for that one pre-chosen side. That meant a stock could
// have a far better put setup sitting unscored and invisible just because it
// happened to tick up 0.2% at the moment of the scan. This function now
// builds AND scores both the call and the put side on the real chain, then
// uses pickBetterSide (convictionScore.cjs) to choose — direction is now a
// scoring OUTPUT, not scoring input. chgPct/SPX direction still feed into each
// side's OWN score (e.g. a call still gets the market-regime penalty if SPX
// is falling) — they just no longer gate which side gets built at all.
//
// srLevels: deliberately NOT fetched inside this function. getSRLevels() in
// srLevels.js does its own network call (Tradier /markets/history) and this
// function stays a pure, synchronous scorer — no awaits, callable identically
// from the cron (which can afford the extra fetch, gated by score) and from
// any future caller that can't. Callers that have S/R data (or none) pass it
// in as a plain object; scanTicker never reaches out for it itself.
// ─────────────────────────────────────────────────────────────────────────
function scanTicker({ ticker, quote, expDates, chain, tf, fund, spxChg, ndxChg, srLevels = null, incumbentSide = null }) {
  const tfCfg2 = TF_CONFIG[tf] || TF_CONFIG['Swing (21–45 DTE)'];
  try {
    if (!quote) return null;
    const price = parseFloat(quote.last||quote.prevclose||0);
    if (!price) return null;
    if (!expDates.length) return null;
    const { date: expiryRaw, dte: pickedDte, isFallback: isFallbackExpiry } = pickExpiry(expDates, tfCfg2.minDTE, tfCfg2.maxDTE);
    if (!chain.length) return null;

    const chgInfo = safeChgPct(quote);
    const chgPct = chgInfo.pct;
    const chgPctEstimated = chgInfo.estimated;
    const step = autoStep(price);

    const vol = quote.volume||0, avg = quote.average_volume||vol;
    const volRatio = vol/(avg||1);
    const now2 = new Date();
    const isMorning2 = isOpeningWindow();
    // dte2 reuses pickExpiry's own midnight-truncated dte (see pickExpiry's
    // comment) instead of recomputing against now2 — previously this used
    // expDate2/now2 directly, which could round to a different integer than
    // the dte pickExpiry used to decide in-range vs. fallback, since now2
    // includes the current hour/minute while pickExpiry's now is midnight-
    // truncated. That mismatch is what let e.g. a Swing-bucket row get
    // stored with a dte technically outside [21,45] despite pickExpiry
    // having selected an expiry it considered in-range.
    const dte2 = pickedDte;

    const hi52 = parseFloat(quote.week_52_high||price);
    const lo52 = parseFloat(quote.week_52_low||price);
    const pos52 = (price-lo52)/((hi52-lo52)||1);

    const spxChgToday = spxChg||0;
    const ndxChgToday = ndxChg||0;

    // srPosition/srDistPct: same level set regardless of side (S/R is a
    // property of the stock's price location, not of call vs put), but
    // srDistPct is always reported as a positive "how far away" number —
    // scoreConviction interprets at_resistance/at_support relative to optType
    // itself, so the same srLevels input is valid for both sides below.
    let srPosition = null, srDistPct = null;
    if (srLevels) {
      srPosition = srLevels.position || null;
      if (srPosition === 'at_resistance' && srLevels.r1) {
        srDistPct = Math.abs(((srLevels.r1 - price) / price) * 100);
      } else if (srPosition === 'at_support' && srLevels.s1) {
        srDistPct = Math.abs(((price - srLevels.s1) / price) * 100);
      }
    }

    // buildSide: builds the contract + computes breakeven + scores ONE side
    // (call or put), fully self-contained so both sides go through identical
    // logic. Returns null if that side has no liquid contracts at all.
    const buildSide = (sideType) => {
      const side = chain.filter(o=>o.option_type===sideType);
      if (!side.length) return null;
      const td = buildNakedResult(chain, price, step, sideType, tfCfg2);
      if (!td) return null;

      const iv = td.iv||0, delta = td.delta||null;

      let breakevenReqPct = null;
      if (td.mid>0) {
        const strike_ = parseFloat(td.primaryStrike||0);
        if (strike_>0) {
          const isPutA = sideType==='put';
          const bePrice_a = isPutA ? (strike_ - td.mid) : (strike_ + td.mid);
          const signedPct = ((bePrice_a / price) - 1) * 100;
          breakevenReqPct = isPutA ? -Math.abs(signedPct) : Math.abs(signedPct);
        }
      }

      const scored = scoreConviction({
        price, chgPct, chgPctEstimated, optType: sideType, iv, delta, volRatio,
        strikeVolume: td.volume||0, pos52, dte: dte2,
        spxChgToday, ndxChgToday, breakevenReqPct,
        isMorningWindow: isMorning2, fundamentals: fund, now: now2, tf,
        gexSign: td.gexSign, gexMagnitude01: td.gexMagnitude01,
        srPosition, srDistPct,
      });

      return { td, breakevenReqPct, ...scored };
    };

    const callSide = buildSide('call');
    const putSide  = buildSide('put');
    const picked = pickBetterSide(callSide, putSide, { incumbentSide });
    if (!picked) return null;

    const { side: optType, winner } = picked;
    const { td, breakevenReqPct, score, reasons, warnings, hardBlocks: hardBlocks2 } = winner;

    // Item 3 — data freshness. safeIV (convictionScore.cjs) silently
    // returns its fallback (0) when Tradier's IV solver failed to converge
    // (the documented 'NaN'-string / out-of-range failure mode) — with NO
    // warning emitted at the point of failure, unlike chgPctEstimated's
    // existing PRE-MARKET ESTIMATE warning a few lines up the call chain.
    // That silent fallback is the actual risky case: iv=0 doesn't just mean
    // "no data," it means "scores as if IV were maximally cheap" (see the
    // IV-band scoring block in convictionScore.cjs) — the worst failure
    // mode, since missing data disguises itself as a positive signal
    // characteristic. td.iv===0 is a safe, sufficient detector here: a
    // genuinely valid IV essentially never computes to exactly zero, so
    // this doesn't need a new field threaded through buildNakedResult —
    // the existing value already tells us what happened.
    if (td.iv === 0) {
      warnings.push('📉 IV UNAVAILABLE — the options pricing solver could not compute implied volatility for this contract (common with stale, zero, or crossed bid/ask quotes). IV-based scoring for this signal used a 0% placeholder, not a real reading — treat the conviction score with extra caution until you can verify current IV yourself.')
    }

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
      iv:fmtPct(td.iv||0), delta:td.delta?td.delta.toFixed(3):'—',
      volume:td.volume||0, oi:td.oi||0,
      expiryDisplay,
      strikeStr: td.strikeStr,
      entry:td.entry, target:td.target, stop:td.stop,
      tfLabel:tfCfg2.label, tfBadge:tfCfg2.badge,
      // Raw (unformatted) fields — added for signal_history outcome tracking.
      // td.mid/price/strike above are pre-formatted display strings; resolution
      // math and Tradier contract re-lookup need the raw numbers/date instead.
      expiryRaw: expiryRaw,
      isFallbackExpiry: isFallbackExpiry,
      midRaw: td.mid,
      bidRaw: td.bid,
      askRaw: td.ask,
      priceRaw: price,
      ivRaw: td.iv||0,
      deltaRaw: td.delta||null,
      primaryStrikeRaw: td.primaryStrike,
      optionType: optType,
      profitTargetPct: tfCfg2.profitTarget,
      stopLossPct: tfCfg2.stopLoss,
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
      // New: visibility into the two-sided decision itself — lets the UI/cron
      // show "Call won 78 vs Put 61 (gap 17)" instead of presenting the
      // winning side as if it were the only side ever considered.
      directionDecision: {
        otherSideScore: picked.loser ? picked.loser.score : null,
        gap: picked.gap,
        isClose: picked.isClose,
        flipped: picked.flipped || false,
        suppressed: picked.suppressed || false,
      },
    };
  } catch { return null; }
}

module.exports = { TF_CONFIG, pickExpiry, buildNakedResult, scanTicker, autoStep, isOpeningWindow, isPreMarket, safeChgPct };
