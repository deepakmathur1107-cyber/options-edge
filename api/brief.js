/**
 * api/brief.js
 * GET  /api/brief  — serve cached brief; generates on-demand if none exists and market is open
 * POST /api/brief  — generate fresh brief (cron or admin trigger)
 * Cron: "0 13 * * 1-5"  (9 AM ET once daily — Vercel Hobby limit)
 */
const { createClient } = require('@supabase/supabase-js')
const { getSRLevels }    = require('./_lib/srLevels')
const { getTickerBrief } = require('./_lib/tickerBrief')
const { getAuth }        = require('./_lib/auth')
const { isTradingDay, isMarketHours, tzParts } = require('./_lib/marketCalendar')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)


async function fetchMarketSnapshot() {
  // Prices via Tradier — already in stack, no extra key needed
  const snap = { spy: null, qqq: null, vix: null, uso: null }
  try {
    const r = await fetch(
      'https://api.tradier.com/v1/markets/quotes?symbols=SPY,QQQ,VIXY,USO',
      {
        headers: {
          Authorization: `Bearer ${process.env.TRADIER_TOKEN}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (r.ok) {
      const data   = await r.json()
      const quotes = data?.quotes?.quote || []
      const arr    = Array.isArray(quotes) ? quotes : [quotes]
      const get    = (sym) => arr.find(q => q.symbol === sym)?.last ?? null
      snap.spy = get('SPY')
      snap.qqq = get('QQQ')
      snap.vix = get('VIXY')  // VIXY = VIX short-term futures ETF, good VIX proxy via Tradier
      snap.uso = get('USO')
    }
  } catch (e) { console.warn('Tradier price fetch failed:', e.message) }
  return snap
}

// Phase 1 prompt: just research, no JSON
function buildSearchPrompt(snap, now) {
  const fmt     = (v, suffix = '') => v != null ? `${v}${suffix}` : 'N/A'
  const dayStr  = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  const dateISO = now.toISOString().slice(0, 10)
  return `You are a market research assistant. Today is ${dayStr} (${dateISO}).

Current prices: SPY ${fmt(snap.spy)} | QQQ ${fmt(snap.qqq)} | VIX proxy ${fmt(snap.vix)} | USO (crude proxy) ${fmt(snap.uso)}

IMPORTANT: Note the current price levels. If SPY/QQQ are significantly up or down, that is itself a key signal.

Run these searches in order:
1. "stock market news today ${dateISO}" — what is moving markets RIGHT NOW
2. "S&P 500 ${dateISO}" — current direction and the main reason
3. "breaking news geopolitical market ${dateISO}" — wars, ceasefires, trade deals, sanctions affecting markets
4. "economic data released ${dateISO}" — any data that came out today

CRITICAL PRIORITY RULE: If there is major breaking news (ceasefire, war escalation, trade deal, surprise Fed action), lead with that. Do NOT default to routine economic calendar items if breaking news exists.

Summarize in 5-8 bullet points ranked by market impact. Be specific — name the event and how markets reacted.`
}

// Phase 2 prompt: JSON generation using research summary
function buildJsonPrompt(snap, now, research) {
  const fmt    = (v, suffix = '') => v != null ? `${v}${suffix}` : 'N/A'
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  return `You are a senior options trader. Today is ${dayStr}.

LIVE PRICES: SPY ${fmt(snap.spy)} | QQQ ${fmt(snap.qqq)} | VIX ${fmt(snap.vix)} | USO ${fmt(snap.uso)}

TODAY'S MARKET RESEARCH:
${research || 'No research available — use prices only.'}

Write a market readout JSON for options traders. Strict field limits — do not exceed:
- tone: exactly 2-3 short words/phrases joined by " / " (e.g. "Risk-off / Defensive")
- why: ONE sentence, maximum 20 words, biggest single market driver
- events: array of 2-4 strings, each maximum 10 words, real events from research
- levels: array of 2-3 strings with price and brief context, use actual prices above
- bias: exactly one of: Bullish, Neutral, Bearish
- risk_trigger: ONE catalyst phrase, maximum 12 words

Respond with ONLY a JSON object. Nothing before {. Nothing after }. No markdown.

{"tone":"...","why":"...","events":[...],"levels":[...],"bias":"Bullish OR Neutral OR Bearish","risk_trigger":"..."}`
}

async function generateAndStore(now) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')
  const snap = await fetchMarketSnapshot()
  console.log('[brief] snap:', JSON.stringify(snap))

  const ANTHROPIC_HEADERS = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  }

  // ── Phase 1: Research — let Claude search the web for today's news ──────────
  const searchPrompt = buildSearchPrompt(snap, now)
  const searchMessages = [{ role: 'user', content: searchPrompt }]
  let researchSummary = ''

  for (let turn = 0; turn < 5; turn++) {
    const r1 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: searchMessages,
      }),
    })
    if (!r1.ok) {
      const err = await r1.json().catch(() => ({}))
      throw new Error(`Claude search error: ${err?.error?.message || r1.status}`)
    }
    const d1 = await r1.json()
    console.log(`[brief] search turn ${turn}:`, d1.stop_reason, (d1.content||[]).map(b=>b.type))
    searchMessages.push({ role: 'assistant', content: d1.content })

    if (d1.stop_reason === 'end_turn') {
      // Claude finished researching — collect its summary text
      const tb = (d1.content || []).filter(b => b.type === 'text').pop()
      researchSummary = tb?.text || ''
      break
    }
    if (d1.stop_reason === 'tool_use') {
      // Feed tool results back so search can complete
      const toolResults = (d1.content || [])
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Search executed.' }))
      searchMessages.push({ role: 'user', content: toolResults })
    }
  }

  console.log('[brief] research summary length:', researchSummary.length)

  // ── Phase 2: Generate JSON — separate call, no tools, strict JSON only ──────
  const jsonMessages = [{
    role: 'user',
    content: buildJsonPrompt(snap, now, researchSummary),
  }]

  const r2 = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: jsonMessages,
    }),
  })
  if (!r2.ok) {
    const err = await r2.json().catch(() => ({}))
    throw new Error(`Claude JSON error: ${err?.error?.message || r2.status}`)
  }
  const d2 = await r2.json()
  const tb2 = (d2.content || []).filter(b => b.type === 'text').pop()
  const rawText = (tb2?.text || '').trim()
  console.log('[brief] json response preview:', rawText.slice(0, 200))

  // Extract JSON object — strip any surrounding prose
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`No JSON in response: ${rawText.slice(0, 300)}`)

  let brief
  try {
    brief = JSON.parse(jsonMatch[0])
  } catch (e) {
    throw new Error(`JSON parse failed: ${rawText.slice(0, 300)}`)
  }

  for (const f of ['tone', 'why', 'events', 'levels', 'bias', 'risk_trigger']) {
    if (!brief[f]) throw new Error(`Missing field: ${f}`)
  }

  // Store — delete old row first, insert fresh one
  // Prune briefs older than 7 days
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
  return { brief, generatedAt: now.toISOString() }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // ── TICKER ANALYSIS MODE — GET /api/brief?ticker=AMZN&... ────────────────
  if (req.method === 'GET' && req.query.ticker) {
    const { clerkId } = await getAuth(req)
    if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })
    const ticker    = (req.query.ticker || '').toUpperCase().trim()
    const price     = parseFloat(req.query.price    || 0)
    const chgPct    = parseFloat(req.query.chgPct   || 0)
    const iv        = req.query.iv        || '0'
    const dte       = req.query.dte       || '30'
    const score     = req.query.score     || '50'
    const tradeType = req.query.tradeType || 'Call'
    if (!ticker) return res.status(400).json({ error: 'Missing ticker' })
    try {
      const sr    = await getSRLevels(ticker)
      const brief = await getTickerBrief({
        ticker, price, chgPct, iv, dte, score, tradeType,
        s1: sr.s1, r1: sr.r1, ma200: sr.ma200, ma50: sr.ma50, position: sr.position,
      })
      return res.status(200).json({ sr, brief })
    } catch (e) {
      console.error('[brief] ticker analysis error:', e.message)
      return res.status(500).json({ error: e.message })
    }
  }

  // POST — cron or manual trigger
  if (req.method === 'POST') {
    const secret = req.headers['x-cron-secret'] ||
      (req.headers['authorization'] || '').replace('Bearer ', '')
    if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' })

    try {
      const result = await generateAndStore(new Date())
      return res.status(200).json({ ok: true, ...result })
    } catch (e) {
      console.error('brief POST error:', e)
      return res.status(500).json({ error: e.message })
    }
  }

  // GET — serve cached brief; generate on-demand if none exists during market hours
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

    const now          = new Date()
    const wantsRefresh = req.query.refresh === '1'

    // Helper: same calendar day in CT?
    function sameDay(a, b) {
      const fmt = d => new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(d))
      return fmt(a) === fmt(b)
    }

    // No brief at all — generate on-demand if market is open, else 404
    if (!data) {
      if (!isMarketHours(now)) {
        return res.status(404).json({ error: 'No brief available yet', notGenerated: true })
      }
      try {
        console.log('No brief found during market hours — generating on-demand')
        const result = await generateAndStore(now)
        return res.status(200).json({ brief: result.brief, generatedAt: result.generatedAt, isOldBrief: false, justRefreshed: true })
      } catch (e) {
        console.error('On-demand generation failed:', e.message)
        return res.status(500).json({ error: 'Brief generation failed: ' + e.message })
      }
    }

    const isOldBrief = !sameDay(data.generated_at, now)

    // Brief is from a previous day and market is open — regenerate
    if (isOldBrief && isMarketHours(now)) {
      try {
        console.log('Brief is from previous day — regenerating')
        const result = await generateAndStore(now)
        return res.status(200).json({ brief: result.brief, generatedAt: result.generatedAt, isOldBrief: false, justRefreshed: true })
      } catch (e) {
        console.error('Regen failed, serving previous day brief:', e.message)
        // Fall through — serve stale rather than error
      }
    }

    // Intraday refresh: on every GET, 7am-4pm CT on trading days, if brief ≥2hrs old
    // Using 7am CT (not 9:30am ET market open) so morning loads get fresh content
    const ctParts  = tzParts(now, 'America/Chicago')
    const ctMins   = parseInt(ctParts.hour, 10) * 60 + parseInt(ctParts.minute, 10)
    const inWindow = isTradingDay(now) && ctMins >= 7 * 60 && ctMins < 16 * 60
    if (inWindow) {
      const ageMs    = now.getTime() - new Date(data.generated_at).getTime()
      const twoHours = 2 * 60 * 60 * 1000
      if (ageMs >= twoHours) {
        try {
          console.log(`Brief is ${Math.round(ageMs / 60000)}min old — auto-refreshing`)
          const result = await generateAndStore(now)
          return res.status(200).json({ brief: result.brief, generatedAt: result.generatedAt, isOldBrief: false, justRefreshed: true })
        } catch (e) {
          console.error('Intraday refresh failed, serving cached:', e.message)
          // Fall through — serve cached
        }
      }
    }

    return res.status(200).json({
      brief: {
        tone:         data.tone,
        why:          data.why,
        events:       data.events,
        levels:       data.levels,
        bias:         data.bias,
        risk_trigger: data.risk_trigger,
      },
      generatedAt:  data.generated_at,
      isOldBrief,
      justRefreshed: false,
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
