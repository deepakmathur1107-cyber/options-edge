/**
 * api/brief.js
 * GET  /api/brief          — serve cached brief (auto-regenerates if ≥2hrs old, 7am-4pm CT)
 * GET  /api/brief?news=1   — return latest Finnhub headlines (for ticker strip, no auth)
 * POST /api/brief          — generate fresh brief (cron or admin trigger via x-cron-secret)
 *
 * Generation: Tradier prices + Finnhub news → single Claude call, no tool loop
 * Cron: "0 13 * * 1-5" (8 AM ET / 7 AM CT daily)
 * Auto-refresh: server regenerates on GET if brief is ≥2hrs old between 7am–4pm CT
 */

const { createClient }    = require('@supabase/supabase-js')
const { getAuth }         = require('./_lib/auth')
const { isTradingDay, tzParts } = require('./_lib/marketCalendar')
const { fetchMarketData, fetchNews } = require('./_lib/newsData')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Is it within the active brief window? (7am–4pm CT, trading days) ────────
function inBriefWindow(now) {
  if (!isTradingDay(now)) return false
  const p    = tzParts(now, 'America/Chicago')
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10)
  return mins >= 7 * 60 && mins < 16 * 60
}

// ── Build the Claude prompt with real data injected ──────────────────────────
function buildPrompt(prices, news, calendar, now) {
  const fmt    = (v, suf = '') => v != null ? `${v}${suf}` : 'N/A'
  const dayStr = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York'
  })
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York'
  })

  const spyDir   = prices.spyChange > 0 ? `+${prices.spyChange?.toFixed(2)}%` : `${prices.spyChange?.toFixed(2)}%`
  const qqqDir   = prices.qqqChange > 0 ? `+${prices.qqqChange?.toFixed(2)}%` : `${prices.qqqChange?.toFixed(2)}%`
  const sessionLabel = prices.session === 'pre'   ? ' [PREMARKET]'
                     : prices.session === 'after'  ? ' [AFTER HOURS]'
                     : prices.session === 'regular' ? ' [MARKET OPEN]'
                     : ' [MARKET CLOSED]'

  const newsSection = news.length > 0
    ? news.map((n, i) => `${i + 1}. ${n.headline} [${n.source}]`).join('\n')
    : 'No recent headlines available.'

  const calSection = calendar.length > 0
    ? calendar.join('\n')
    : 'No high-impact events today.'

  return `You are a senior options trader writing a market readout for OptionsEdgeFlow.
Today is ${dayStr}, ${timeStr} ET.

LIVE PRICES (Tradier)${sessionLabel}:
SPY: ${fmt(prices.spy)} (${spyDir}) | QQQ: ${fmt(prices.qqq)} (${qqqDir}) | VIXY: ${fmt(prices.vixy)} | USO: ${fmt(prices.uso)}

LATEST MARKET NEWS (last 8 hours):
${newsSection}

TODAY'S ECONOMIC CALENDAR (high/medium impact):
${calSection}

Write an accurate, specific market readout for options traders based on the ACTUAL news above.
If there is a major geopolitical event (ceasefire, war, trade deal, Fed surprise), it MUST drive the bias and tone.
Do not invent events. Use the real headlines provided.

Respond with ONLY a JSON object. Nothing before {. Nothing after }. No markdown. No explanation.

{"tone":"2-3 short descriptors e.g. Risk-on / Ceasefire Rally / Momentum","why":"ONE sentence max 20 words — biggest driver right now","events":["2-4 real events from the news above, max 10 words each"],"levels":["2-3 key price levels with brief context, use actual SPY/QQQ prices"],"bias":"Bullish OR Neutral OR Bearish","risk_trigger":"ONE phrase max 12 words that would flip the bias"}`
}

// ── Generate brief and store in Supabase ────────────────────────────────────
async function generateAndStore(now) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  // Fetch prices + news in parallel
  const { prices, news, calendar } = await fetchMarketData()
  console.log(`[brief] prices: SPY=${prices.spy} QQQ=${prices.qqq} VIXY=${prices.vixy}`)
  console.log(`[brief] news items: ${news.length}, calendar items: ${calendar.length}`)

  // Single Claude call — no tool loop, no multi-turn, no whitespace issues
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages:   [{ role: 'user', content: buildPrompt(prices, news, calendar, now) }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Claude error: ${err?.error?.message || res.status}`)
  }

  const data      = await res.json()
  const textBlock = (data.content || []).filter(b => b.type === 'text').pop()
  const rawText   = (textBlock?.text || '').trim()
  console.log('[brief] Claude response preview:', rawText.slice(0, 150))

  // Extract JSON — handle any surrounding prose
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`No JSON in response: ${rawText.slice(0, 200)}`)

  let brief
  try { brief = JSON.parse(jsonMatch[0]) }
  catch (e) { throw new Error(`JSON parse failed: ${rawText.slice(0, 200)}`) }

  for (const f of ['tone', 'why', 'events', 'levels', 'bias', 'risk_trigger']) {
    if (!brief[f]) throw new Error(`Missing field: ${f}`)
  }

  // Store in Supabase — delete old, insert fresh
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('morning_brief').delete().lt('generated_at', cutoff)
  const { error } = await supabase.from('morning_brief').insert({
    generated_at: now.toISOString(),
    tone:         brief.tone,
    why:          brief.why,
    events:       brief.events,
    levels:       brief.levels,
    bias:         brief.bias,
    risk_trigger: brief.risk_trigger,
    raw_json:     brief,
  })
  if (error) throw new Error(`Supabase: ${error.message}`)

  console.log(`[brief] Generated: ${brief.bias} — ${brief.why}`)
  return { brief, generatedAt: now.toISOString() }
}

// ── Same-calendar-day check (CT) ─────────────────────────────────────────────
function sameDay(isoA, isoB) {
  const fmt = d => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(d))
  return fmt(isoA) === fmt(isoB)
}

// ── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-cron-secret')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // ── GET ?news=1 — return raw Finnhub headlines for ticker strip ────────────
  if (req.method === 'GET' && req.query.news === '1') {
    const headlines = await fetchNews().catch(() => [])
    return res.status(200).json({ news: headlines })
  }

  // ── POST — cron or admin force-generate ───────────────────────────────────
  if (req.method === 'POST') {
    const secret = req.headers['x-cron-secret'] || ''
    const isCron = process.env.CRON_SECRET && secret === process.env.CRON_SECRET

    if (!isCron) {
      const { clerkId } = await getAuth(req)
      const ADMIN_IDS   = (process.env.ADMIN_CLERK_IDS || '').split(',').map(s => s.trim())
      if (!clerkId || !ADMIN_IDS.includes(clerkId)) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
    }

    try {
      const result = await generateAndStore(new Date())
      return res.status(200).json({ ok: true, brief: result.brief, generatedAt: result.generatedAt })
    } catch (e) {
      console.error('[brief] POST generation failed:', e.message)
      return res.status(500).json({ error: e.message })
    }
  }

  // ── GET — serve cached brief, auto-regenerate if stale ───────────────────
  if (req.method === 'GET') {
    const { clerkId } = await getAuth(req)
    if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })

    const { data, error } = await supabase
      .from('morning_brief')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })

    const now        = new Date()
    const isOldBrief = !data || !sameDay(data.generated_at, now.toISOString())

    // No brief today — regenerate if in window, else 404
    if (!data || isOldBrief) {
      if (!inBriefWindow(now)) {
        if (!data) return res.status(404).json({ error: 'No brief yet', notGenerated: true })
        // Serve yesterday's brief after hours rather than 404
        return res.status(200).json({
          brief:        { tone: data.tone, why: data.why, events: data.events, levels: data.levels, bias: data.bias, risk_trigger: data.risk_trigger },
          generatedAt:  data.generated_at,
          isOldBrief:   true,
          justRefreshed: false,
        })
      }
      try {
        console.log('[brief] No today brief in window — generating')
        const result = await generateAndStore(now)
        return res.status(200).json({ brief: result.brief, generatedAt: result.generatedAt, isOldBrief: false, justRefreshed: true })
      } catch (e) {
        console.error('[brief] On-demand generation failed:', e.message)
        if (!data) return res.status(500).json({ error: e.message })
        // Fall through — serve yesterday's if generation fails
      }
    }

    // Brief exists for today — check 2hr auto-refresh window
    if (inBriefWindow(now)) {
      const ageMs    = now.getTime() - new Date(data.generated_at).getTime()
      const twoHours = 2 * 60 * 60 * 1000
      if (ageMs >= twoHours) {
        try {
          console.log(`[brief] ${Math.round(ageMs / 60000)}min old — auto-refreshing`)
          const result = await generateAndStore(now)
          return res.status(200).json({ brief: result.brief, generatedAt: result.generatedAt, isOldBrief: false, justRefreshed: true })
        } catch (e) {
          console.error('[brief] Auto-refresh failed, serving cached:', e.message)
          // Fall through — serve cached rather than error
        }
      }
    }

    // Serve cached brief
    return res.status(200).json({
      brief:        { tone: data.tone, why: data.why, events: data.events, levels: data.levels, bias: data.bias, risk_trigger: data.risk_trigger },
      generatedAt:  data.generated_at,
      isOldBrief:   false,
      justRefreshed: false,
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
