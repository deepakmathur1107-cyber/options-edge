/**
 * api/brief.js — Vercel Serverless Function
 *
 * GET  /api/brief          → returns cached brief (all users, auth required)
 * POST /api/brief          → generates fresh brief (cron only, secret required)
 *
 * Cron: "0 13-21 * * 1-5"  (hourly 8AM–4PM ET on weekdays)
 * This single file replaces both api/brief/generate.js + api/brief/latest.js,
 * keeping us within Vercel Hobby's 12-function limit.
 */

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

// ── JWT decode ────────────────────────────────────────────────────────────
function decodeJwt(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    )
  } catch { return null }
}

// ── Fetch live market snapshot ────────────────────────────────────────────
async function fetchMarketSnapshot() {
  const snap = {
    sp500: null, nasdaq: null, dow: null,
    vix: null, dxy: null, crude: null, btc: null,
    us10y: null, us2y: null,
  }
  try {
    const symbols = '^SP500,^NDX,^DJI,^VIX,DX-Y.NYB,CL=F,BTCUSD'
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/quote-short/${encodeURIComponent(symbols)}?apikey=demo`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (r.ok) {
      const data = await r.json()
      const get = (sym) => data.find(d => d.symbol === sym)?.price ?? null
      snap.sp500  = get('^SP500')
      snap.nasdaq = get('^NDX')
      snap.dow    = get('^DJI')
      snap.vix    = get('^VIX')
      snap.dxy    = get('DX-Y.NYB')
      snap.crude  = get('CL=F')
      snap.btc    = get('BTCUSD')
    }
  } catch (e) { console.warn('Snapshot fetch failed:', e.message) }
  return snap
}

// ── Build Claude prompt ───────────────────────────────────────────────────
function buildPrompt(snap, now) {
  const fmt = (v, suffix = '') => v != null ? `${v}${suffix}` : 'N/A'
  const dayStr  = now.toLocaleDateString('en-US',  { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  const timeStr = now.toLocaleTimeString('en-US',  { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })

  return `You are a senior options trader writing the morning market brief for OptionsEdgeFlow, a professional options trading platform. Today is ${dayStr}, ${timeStr} ET.

LIVE MARKET DATA:
- S&P 500: ${fmt(snap.sp500)}
- Nasdaq 100: ${fmt(snap.nasdaq)}
- Dow Jones: ${fmt(snap.dow)}
- VIX: ${fmt(snap.vix)}
- US 10Y Yield: ${fmt(snap.us10y, '%')}
- US 2Y Yield: ${fmt(snap.us2y, '%')}
- DXY: ${fmt(snap.dxy)}
- Crude Oil: ${fmt(snap.crude)}
- BTC: ${fmt(snap.btc)}

Write a morning market readout for options traders. Be direct, filtered, and action-oriented — not a news dump. Help the trader decide: lean long, reduce risk, or stay defensive.

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{
  "tone": "2-3 descriptors e.g. Risk-off / Yield-driven / Defensive",
  "why": "One sentence max 20 words on the single biggest market driver",
  "events": ["2-4 bullets on key events today, max 12 words each, most important first"],
  "levels": ["2-3 key price or yield levels with context e.g. SPY 520 — key support, 3 tests this week"],
  "bias": "Bullish OR Neutral OR Bearish",
  "risk_trigger": "One concrete catalyst that would flip the bias, max 15 words"
}`
}

// ── Call Claude (Haiku — cheapest, ~$0.001/call) ──────────────────────────
async function generateBrief(snap, now) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: buildPrompt(snap, now) }],
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Claude error: ${err?.error?.message || res.status}`)
  }
  const data = await res.json()
  const text = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}

// ── Email HTML ────────────────────────────────────────────────────────────
function buildEmailHtml(brief, generatedAt) {
  const biasColor = { Bullish: '#00ff88', Neutral: '#ff9500', Bearish: '#ff4466' }[brief.bias] || '#c8d8e8'
  const timeStr = new Date(generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })

  const eventRows = (brief.events || []).map(e => `<li style="margin-bottom:4px">${e}</li>`).join('')
  const levelRows = (brief.levels || []).map(l => `<li style="margin-bottom:4px;font-family:monospace">${l}</li>`).join('')

  return `
    <div style="background:#090e14;color:#c8d8e8;font-family:Inter,sans-serif;padding:32px;max-width:600px;margin:0 auto">
      <h1 style="font-family:'Bebas Neue',sans-serif;color:#00ff88;letter-spacing:3px;margin-bottom:4px">OPTIONS EDGE — MORNING READOUT</h1>
      <p style="color:#4a7a8a;font-size:11px;font-family:monospace;margin-top:0">${timeStr} ET</p>

      <div style="background:${biasColor}15;border:1px solid ${biasColor}40;border-radius:6px;padding:16px;margin:16px 0">
        <div style="font-size:22px;font-weight:900;color:${biasColor};letter-spacing:2px;font-family:'Bebas Neue',sans-serif">${brief.bias?.toUpperCase()}</div>
        <div style="font-size:11px;color:#4a7a8a;margin-bottom:8px">${brief.tone}</div>
        <div style="font-size:13px;color:#c8d8e8">${brief.why}</div>
      </div>

      <div style="background:#ff446610;border:1px solid #ff446630;border-radius:6px;padding:12px;margin-bottom:16px">
        <span style="font-size:10px;font-weight:700;color:#ff6688;font-family:monospace">⚡ RISK TRIGGER — </span>
        <span style="font-size:12px;color:#c8d8e8">${brief.risk_trigger}</span>
      </div>

      <p style="font-size:11px;font-weight:700;letter-spacing:1px;color:#4a7a8a;font-family:monospace">TODAY'S EVENTS</p>
      <ul style="font-size:12px;color:#c8d8e8;padding-left:20px">${eventRows}</ul>

      <p style="font-size:11px;font-weight:700;letter-spacing:1px;color:#4a7a8a;font-family:monospace">KEY LEVELS</p>
      <ul style="font-size:12px;color:#c8d8e8;padding-left:20px">${levelRows}</ul>

      <p style="color:#2a4a5a;font-size:10px;font-family:monospace;margin-top:24px;border-top:1px solid #1a2e3e;padding-top:12px">
        AI-generated · Not financial advice · <a href="https://optionsedgeflow.com/app" style="color:#4a7a8a">View in app</a>
      </p>
    </div>`
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // ── POST: generate (cron / manual trigger) ────────────────────────────
  if (req.method === 'POST') {
    const secret = req.headers['x-cron-secret'] ||
      (req.headers['authorization'] || '').replace('Bearer ', '')
    if (secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
    }

    const now = new Date()
    try {
      const snap  = await fetchMarketSnapshot()
      const brief = await generateBrief(snap, now)

      // Validate
      for (const f of ['tone', 'why', 'events', 'levels', 'bias', 'risk_trigger']) {
        if (!brief[f]) throw new Error(`Missing field: ${f}`)
      }

      // Clear old rows and insert fresh one
      await supabase.from('morning_brief').delete().neq('id', 0)

      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
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
      if (error) throw new Error(`Supabase: ${error.message}`)

      console.log(`Brief generated at ${now.toISOString()}, bias: ${brief.bias}`)
      return res.status(200).json({ ok: true, generatedAt: now.toISOString(), brief })
    } catch (e) {
      console.error('brief POST error:', e)
      return res.status(500).json({ error: e.message })
    }
  }

  // ── GET: serve cached brief to users ─────────────────────────────────
  if (req.method === 'GET') {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
    if (!token || !decodeJwt(token)?.sub) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('morning_brief')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: 'No brief available yet', notGenerated: true })

    const isStale = new Date(data.expires_at) < new Date()
    return res.status(200).json({
      brief: {
        tone:         data.tone,
        why:          data.why,
        events:       data.events,
        levels:       data.levels,
        bias:         data.bias,
        risk_trigger: data.risk_trigger,
      },
      generatedAt: data.generated_at,
      expiresAt:   data.expires_at,
      isStale,
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
