/**
 * api/brief.js
 * GET  /api/brief  — serve cached brief to users (Clerk JWT required)
 * POST /api/brief  — generate fresh brief (cron secret required)
 * Cron: "0 13-21 * * 1-5"
 */
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function decodeJwt(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    )
  } catch { return null }
}

async function fetchMarketSnapshot() {
  const snap = { sp500: null, nasdaq: null, dow: null, vix: null, dxy: null, crude: null, btc: null }
  try {
    const symbols = encodeURIComponent('^SP500,^NDX,^DJI,^VIX,DX-Y.NYB,CL=F,BTCUSD')
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/quote-short/${symbols}?apikey=demo`,
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
  } catch (e) { console.warn('Snapshot failed:', e.message) }
  return snap
}

function buildPrompt(snap, now) {
  const fmt = (v, suffix = '') => v != null ? `${v}${suffix}` : 'N/A'
  const dayStr  = now.toLocaleDateString('en-US',  { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  const timeStr = now.toLocaleTimeString('en-US',  { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
  return `You are a senior options trader writing the morning market brief for OptionsEdgeFlow. Today is ${dayStr}, ${timeStr} ET.

LIVE MARKET DATA:
S&P 500: ${fmt(snap.sp500)} | Nasdaq: ${fmt(snap.nasdaq)} | Dow: ${fmt(snap.dow)}
VIX: ${fmt(snap.vix)} | DXY: ${fmt(snap.dxy)} | Crude: ${fmt(snap.crude)} | BTC: ${fmt(snap.btc)}

Write a market readout for options traders. Be direct and action-oriented. Help the trader decide: lean long, reduce risk, or stay defensive.

Return ONLY valid JSON with no markdown, no backticks:
{
  "tone": "2-3 descriptors e.g. Risk-off / Yield-driven / Defensive",
  "why": "One sentence max 20 words on the biggest market driver",
  "events": ["2-4 key events today max 12 words each"],
  "levels": ["2-3 key price levels with context"],
  "bias": "Bullish OR Neutral OR Bearish",
  "risk_trigger": "One catalyst that would flip the bias max 15 words"
}`
}

async function generateBrief(snap, now) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // POST — cron generates brief
  if (req.method === 'POST') {
    const secret = req.headers['x-cron-secret'] ||
      (req.headers['authorization'] || '').replace('Bearer ', '')
    if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

    const now = new Date()
    try {
      const snap  = await fetchMarketSnapshot()
      const brief = await generateBrief(snap, now)

      for (const f of ['tone', 'why', 'events', 'levels', 'bias', 'risk_trigger']) {
        if (!brief[f]) throw new Error(`Missing field: ${f}`)
      }

      await supabase.from('morning_brief').delete().neq('id', 0)

      const { error } = await supabase.from('morning_brief').insert({
        generated_at: now.toISOString(),
        expires_at:   new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        tone:         brief.tone,
        why:          brief.why,
        events:       brief.events,
        levels:       brief.levels,
        bias:         brief.bias,
        risk_trigger: brief.risk_trigger,
        raw_json:     brief,
      })
      if (error) throw new Error(`Supabase: ${error.message}`)

      return res.status(200).json({ ok: true, generatedAt: now.toISOString(), brief })
    } catch (e) {
      console.error('brief POST error:', e)
      return res.status(500).json({ error: e.message })
    }
  }

  // GET — serve cached brief to users
  if (req.method === 'GET') {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
    if (!token || !decodeJwt(token)?.sub) return res.status(401).json({ error: 'Unauthorized' })

    const { data, error } = await supabase
      .from('morning_brief')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: 'No brief available yet', notGenerated: true })

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
      isStale:     new Date(data.expires_at) < new Date(),
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
