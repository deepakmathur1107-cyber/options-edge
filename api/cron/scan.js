// api/cron/scan.js
//
// Server-side replacement for the browser-only auto-scanner loop. Triggered by
// Vercel Cron (see vercel.json) every 15 minutes. Each invocation scans ONE
// timeframe across the watchlist (rotated — see SCHEDULE below) so a single
// run comfortably fits inside the Pro tier's maxDuration, and writes every
// result into Supabase scan_results so the frontend can read instantly
// instead of re-scanning live.
//
// Schedule (set in vercel.json):
//   Quick Play  + Swing Trade  → every 15 min (fast-moving setups)
//   LEAP        + Deep LEAP    → every 60 min (slow-moving, don't need 15-min refresh)
//
// This file orchestrates; api/_lib/scanLogic.js holds the actual scoring math
// (ported from src/App.jsx's scanOneTicker so behaviour matches exactly).

const { TF_CONFIG, pickExpiry, scanTicker, safeChgPct } = require('../_lib/scanLogic')
const { getFundamentals } = require('../_lib/fundamentals')
const { SP500 } = require('../_lib/sp500')

const TRADIER_MODE  = process.env.TRADIER_MODE  || 'production'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || ''
const TRADIER_BASE  = TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1'
const CRON_SECRET   = process.env.CRON_SECRET || ''

// Lazy Supabase singleton — never crash the module on import if env vars are
// briefly missing during a deploy race (same defensive pattern as fundamentals.js,
// learned from a prior production outage caused by a top-level require crash).
let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[cron/scan] supabase init failed:', e.message) }
  }
  return _sb
}

async function tFetch(path) {
  const url = `${TRADIER_BASE}${path}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } })
  if (!r.ok) return null
  try { return await r.json() } catch { return null }
}
const getQuote    = async sym => { const d = await tFetch(`/markets/quotes?symbols=${sym}&greeks=false`); return d?.quotes?.quote || null }
const getExpiries = async sym => { const d = await tFetch(`/markets/options/expirations?symbol=${sym}&includeAllRoots=false`); return d?.expirations?.date || [] }
const getChain     = async (sym, exp) => { const d = await tFetch(`/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=true`); return d?.options?.option || [] }

// Batched concurrency helper — runs `worker` over `items`, `batchSize` at a time.
async function runBatched(items, batchSize, worker) {
  const out = []
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize)
    const results = await Promise.all(slice.map(worker))
    out.push(...results)
  }
  return out
}

module.exports = async function handler(req, res) {
  // Vercel Cron calls this with a special header; also accept a manual secret
  // so this can be triggered for testing without waiting for the schedule.
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
                     || req.headers['x-vercel-cron'] === '1'   // secondary signal — covers
                                                                // the rare case CRON_SECRET
                                                                // doesn't arrive in the header
  const isManualTrigger = req.query.secret && req.query.secret === CRON_SECRET
  if (!isVercelCron && !isManualTrigger && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized — cron secret missing/invalid' })
  }

  const tf = req.query.tf || 'Swing (21–45 DTE)'
  const tfCfg = TF_CONFIG[tf]
  if (!tfCfg) {
    // Fails loudly rather than silently — a mismatched dash character or
    // URL-encoding quirk between vercel.json's cron path and TF_CONFIG's keys
    // would otherwise just 400 with no trace in the cron's own dashboard.
    console.error(`[cron/scan] Unknown timeframe "${tf}" — known keys: ${Object.keys(TF_CONFIG).join(', ')}`)
    return res.status(400).json({ error: `Unknown timeframe: ${tf}`, knownKeys: Object.keys(TF_CONFIG) })
  }

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  const startedAt = Date.now()
  const MAX_MS = 280_000   // leave 20s headroom under the 300s Pro maxDuration
  const MIN_WRITE_SCORE = 60   // only persist results worth surfacing — raise this
                               // (e.g. to 65 or 70) if the table still feels noisy

  // Market regime — fetched once per run, shared across all tickers (mirrors
  // esBar/nqBar in the frontend, which are also fetched once and reused).
  let spxChg = 0, ndxChg = 0
  try {
    const [spxQ, ndxQ] = await Promise.all([getQuote('SPX'), getQuote('NDX')])
    spxChg = safeChgPct(spxQ).pct
    ndxChg = safeChgPct(ndxQ).pct
  } catch (e) { console.error('[cron/scan] market regime fetch failed:', e.message) }

  const tickers = SP500
  let scanned = 0, qualified = 0, errors = 0

  await runBatched(tickers, 8, async (ticker) => {
    if (Date.now() - startedAt > MAX_MS) return null   // time budget guard

    try {
      const [quote, expDates] = await Promise.all([getQuote(ticker), getExpiries(ticker)])
      if (!quote || !expDates.length) { scanned++; return null }
      const price = parseFloat(quote.last || quote.prevclose || 0)
      if (!price) { scanned++; return null }
      const expiryRaw = pickExpiry(expDates, tfCfg.minDTE, tfCfg.maxDTE)
      const chain = await getChain(ticker, expiryRaw)
      if (!chain.length) { scanned++; return null }

      const r = scanTicker({ ticker, quote, expDates, chain, tf, fund: null, spxChg, ndxChg })
      scanned++
      if (!r) return null

      // Below-threshold results are intentionally NOT written to scan_results —
      // a previous version wrote every scored ticker regardless, which silently
      // filled the table with ~70% C-grade noise (avg score 47) because this
      // gate only wrapped the fundamentals fetch, not the write itself.
      if (r.score < MIN_WRITE_SCORE) return null

      // Fundamentals only fetched for tickers worth showing — same rationale
      // as the earlier client-side fix: don't spend API budget on misses.
      const fund = await getFundamentals(ticker).catch(() => null)
      if (fund) {
        // Re-run with fundamentals to apply the large-cap/earnings adjustments
        const r2 = scanTicker({ ticker, quote, expDates, chain, tf, fund, spxChg, ndxChg })
        if (r2) Object.assign(r, r2)
      }

      const scannedAt = new Date()
      const expiresAt = new Date(scannedAt.getTime() + 20 * 60 * 1000)   // 20 min TTL

      const row = {
        ticker, timeframe: tf, score: r.score, grade: r.grade,
        trade_type: r.tradeType, strike_str: r.strikeStr,
        mid: r.mid, bid: r.bid, ask: r.ask,
        entry: r.entry, target: r.target, stop: r.stop,
        breakeven: r.breakeven, breakeven_pct: r.breakevenPct,
        dte: r.dte, iv: r.iv, delta: r.delta, chg_pct: r.chgPct,
        volume: r.volume, oi: r.oi,
        reasons: r.reasons, warnings: r.warnings, hard_blocks: r.hardBlocks,
        sector: r.sector, industry: r.industry, market_cap: r.marketCap,
        earnings_date: r.earningsDate, expiry_display: r.expiryDisplay,
        scanned_at: scannedAt.toISOString(), expires_at: expiresAt.toISOString(),
      }

      const { error } = await client.from('scan_results').upsert(row, { onConflict: 'ticker,timeframe' })
      if (error) { console.error(`[cron/scan] upsert failed for ${ticker}:`, error.message); errors++; return null }

      qualified++
      return r
    } catch (e) {
      console.error(`[cron/scan] ${ticker} failed:`, e.message)
      errors++
      return null
    }
  })

  const durationMs = Date.now() - startedAt
  console.log(`[cron/scan] tf=${tf} scanned=${scanned} qualified=${qualified} errors=${errors} duration=${durationMs}ms`)

  return res.status(200).json({
    timeframe: tf, scanned, qualified, errors, durationMs,
    truncated: durationMs > MAX_MS,
  })
}
