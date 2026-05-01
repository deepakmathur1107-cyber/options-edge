// api/morning.js — Morning market brief via Claude AI (no web-search — stays under Vercel 10s limit)
// Requires ANTHROPIC_API_KEY in Vercel env vars  -OR-  paste key in app ⚙ Settings → Claude AI

module.exports = async function handler(req, res) {
  // Always respond JSON — prevents "Unexpected token" crash in the browser
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.status(200).end(); return }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {}

  // Priority: Vercel env var (secure) → key pasted in app Settings (instant fallback)
  const apiKey = process.env.ANTHROPIC_API_KEY || body.apiKey

  if (!apiKey) {
    return res.status(400).json({
      error: [
        'No Anthropic API key found. Two ways to fix:',
        '',
        'A) Instant — paste your key in ⚙ Tools → Settings → Claude AI section in the app.',
        '   Get a free key at: console.anthropic.com → API Keys',
        '',
        'B) Permanent — add ANTHROPIC_API_KEY in Vercel → Project → Settings →',
        '   Environment Variables, then redeploy.',
      ].join('\n')
    })
  }

  const { spxPrice, spxChange, ndxPrice, ndxChange } = body
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  const spxLine = spxPrice ? `SPX ${spxPrice} (${Number(spxChange) >= 0 ? '+' : ''}${spxChange}%)` : 'SPX: not loaded'
  const ndxLine = ndxPrice ? `NDX ${ndxPrice} (${Number(ndxChange) >= 0 ? '+' : ''}${ndxChange}%)` : 'NDX: not loaded'

  const prompt = `Generate a pre-market morning briefing for options traders. Today is ${today}.

Current index snapshot: ${spxLine} | ${ndxLine}

Format as plain text with 5 ALL-CAPS section headers. No markdown. No bullet symbols. Keep each section under 3 lines.

MARKET DIRECTION: Assess the overall trend (bullish / bearish / choppy) based on recent SPX/NDX price action and overnight context. Reference the index values above.

TOP HEADLINES: List 3 market-moving themes or macro events likely relevant this week — earnings season, Fed policy, inflation data, geopolitical risk, or sector rotation. Be specific.

ECONOMIC CALENDAR: Name 2-3 key data types typically released this time of month and their expected market impact (e.g., NFP, CPI, FOMC minutes, PMI). Note high/medium/low impact.

KEY LEVELS: Give specific SPX and NDX support and resistance levels based on the prices above. Include a round-number level, a recent high/low zone, and a psychological level.

TRADE BIAS: One sentence — directional lean for the session and the primary risk that would invalidate it.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    // Read as text first — never assume JSON from upstream
    const raw = await response.text()
    let data
    try { data = JSON.parse(raw) } catch {
      return res.status(502).json({ error: `Claude API returned non-JSON: ${raw.slice(0, 200)}` })
    }

    if (data.error) {
      return res.status(400).json({ error: `Claude API error: ${data.error.message || JSON.stringify(data.error)}` })
    }

    const brief = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()

    return res.status(200).json({
      brief: brief || 'No content returned from Claude.',
      generatedAt: new Date().toISOString(),
      model: data.model,
    })
  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}` })
  }
}
