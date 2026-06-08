/**
 * api/brief/generate.js — Vercel Serverless Function
 *
 * Cron: "0 * * * 1-5"  (every hour on weekdays)
 * Manual: POST /api/brief/generate  with header x-cron-secret: <CRON_SECRET>
 *
 * Flow:
 *  1. Fetch real market data (futures, yields, key levels) via web search
 *  2. Call Claude with structured prompt → get JSON brief
 *  3. Upsert into Supabase morning_brief table (one live row)
 *  4. All users read from that cached row — zero per-user API cost
 */

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

// ── Fetch live market context via Brave/web search fallback ───────────────
// We call financialmodelingprep free tier for futures + yields (no key needed
// for basic quotes), then pass the numbers into Claude's prompt.
async function fetchMarketSnapshot() {
  const snapshot = {
    spyFutures: null,
    nasdaqFutures: null,
    dowFutures: null,
    us10y: null,
    us2y: null,
    vix: null,
    dxy: null,
    crude: null,
    btc: null,
  }

  try {
    // FMP free endpoint — no API key required for basic quotes
    const symbols = '%5ESP500%2C%5ENDX%2C%5EDJI%2C%5EVIX%2CDX-Y.NYB%2CCL%3DF%2CBZ%3DF%2CBTCUSD'
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/quote-short/${symbols}?apikey=demo`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (r.ok) {
      const data = await r.json()
      const get = (sym) => data.find(d => d.symbol === sym)?.price ?? null
      snapshot.spyFutures     = get('^SP500')
      snapshot.nasdaqFutures  = get('^NDX')
      snapshot.dowFutures     = get('^DJI')
      snapshot.vix            = get('^VIX')
      snapshot.dxy            = get('DX-Y.NYB')
      snapshot.crude          = get('CL=F')
      snapshot.btc            = get('BTCUSD')
    }
  } catch (e) {
    console.warn('Market snapshot fetch failed (non-fatal):', e.message)
  }

  try {
    // US Treasury yields from Treasury.gov
    const r = await fetch(
      'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value_month=' +
      new Date().toISOString().slice(0, 7).replace('-', ''),
      { signal: AbortSignal.timeout(5000) }
    )
    if (r.ok) {
      const text = await r.text()
      // Parse the last row for 2Y and 10Y
      const rows = text.match(/\d+\.\d+/g)
      if (rows && rows.length >= 8) {
        snapshot.us2y  = parseFloat(rows[rows.length - 8])
        snapshot.us10y = parseFloat(rows[rows.length - 4])
      }
    }
  } catch (e) {
    console.warn('Yield fetch failed (non-fatal):', e.message)
  }

  return snapshot
}

// ── Build Claude prompt ───────────────────────────────────────────────────
function buildPrompt(snap, now) {
  const fmt = (v, prefix = '') => v != null ? `${prefix}${v}` : 'unavailable'
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })

  return `You are a senior options trader writing the morning market brief for OptionsEdgeFlow, a professional options trading platform. Today is ${dayStr}, ${timeStr} ET.

LIVE MARKET DATA (as of generation time):
- S&P 500: ${fmt(snap.spyFutures)}
- Nasdaq 100: ${fmt(snap.nasdaqFutures)}
- Dow Jones: ${fmt(snap.dowFutures)}
- VIX: ${fmt(snap.vix)}
- US 10Y Yield: ${fmt(snap.us10y, '')}%
- US 2Y Yield: ${fmt(snap.us2y, '')}%
- DXY (Dollar): ${fmt(snap.dxy)}
- Crude Oil: ${fmt(snap.crude)}
- BTC: ${fmt(snap.btc)}

Write a morning market readout for options traders. Be direct, filtered, and action-oriented — not a news dump. Help the trader decide: lean long, reduce risk, or stay defensive.

Return ONLY a valid JSON object with exactly these fields (no markdown, no explanation, no backticks):
{
  "tone": "e.g. Mixed / Tech-led / Risk-off",
  "why": "One sentence on the single biggest market driver right now",
  "events": ["2-4 bullets on key events today: Fed speakers, earnings, economic data, etc."],
  "levels": ["2-3 key price or yield levels traders should watch today with context"],
  "bias": "Bullish OR Neutral OR Bearish",
  "risk_trigger": "The one specific thing that would flip the bias — be concrete"
}

Rules:
- tone: 2-3 descriptors separated by " / " (e.g. "Risk-off / Yield-driven / Defensive")
- why: max 20 words, no hedging language
- events: each bullet max 12 words, most important first
- levels: each bullet includes the level and why it matters (e.g. "SPY 520 — key support, 3 tests this week")
- bias: exactly one word from: Bullish, Neutral, Bearish
- risk_trigger: one concrete catalyst, max 15 words`
}

// ── Call Claude API ───────────────────────────────────────────────────────
async function generateBrief(snap, now) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',   // cheapest model — perfect for structured JSON
      max_tokens: 600,
      messages: [{ role: 'user', content: buildPrompt(snap, now) }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Claude API error: ${err?.error?.message || res.status}`)
  }

  const data = await res.json()
  const text = data.content?.[0]?.text || ''

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = req.headers['x-cron-secret'] ||
    (req.headers['authorization'] || '').replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  const now = new Date()

  try {
    // 1. Fetch market data
    const snap = await fetchMarketSnapshot()
    console.log('Market snapshot:', JSON.stringify(snap))

    // 2. Generate brief via Claude
    const brief = await generateBrief(snap, now)
    console.log('Generated brief:', JSON.stringify(brief))

    // Validate required fields
    const required = ['tone', 'why', 'events', 'levels', 'bias', 'risk_trigger']
    for (const f of required) {
      if (!brief[f]) throw new Error(`Missing field in Claude response: ${f}`)
    }

    // 3. Upsert into Supabase — delete old rows, insert fresh one
    await supabase.from('morning_brief').delete().neq('id', 0)  // clear all

    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)  // +1 hour

    const { error } = await supabase.from('morning_brief').insert({
      generated_at: now.toISOString(),
      expires_at:   expiresAt.toISOString(),
      tone:         brief.tone,
      why:          brief.why,
      events:       brief.events,
      levels:       brief.levels,
      bias:         brief.bias,
      risk_trigger: brief.risk_trigger,
      raw_json:     brief,
    })

    if (error) throw new Error(`Supabase insert error: ${error.message}`)

    return res.status(200).json({
      ok: true,
      generatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      brief,
    })
  } catch (e) {
    console.error('brief/generate error:', e)
    return res.status(500).json({ error: e.message })
  }
}
