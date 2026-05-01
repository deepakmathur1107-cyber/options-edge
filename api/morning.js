// api/morning.js — Morning market brief via Claude AI + web search
// Requires ANTHROPIC_API_KEY in Vercel environment variables

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.status(200).end(); return }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    res.status(400).json({
      error: 'ANTHROPIC_API_KEY not set.\n\nAdd it in Vercel → Project → Settings → Environment Variables, then redeploy.'
    })
    return
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {}

  const { spxPrice, spxChange, ndxPrice, ndxChange } = body
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  const systemPrompt = `You are a pre-market trading analyst writing a concise morning briefing for options traders.
Format rules:
- Plain text only — no markdown, no asterisks, no hyphens as bullets
- Use ALL CAPS for section headers followed by a colon
- Keep each section to 2-3 lines max
- Be data-driven and specific (prices, percentages, dates)
- Focus exclusively on what matters to SPX/NDX options traders

Current market snapshot:
SPX: ${spxPrice || 'N/A'} (${spxChange >= 0 ? '+' : ''}${spxChange || 'N/A'}%)
NDX: ${ndxPrice || 'N/A'} (${ndxChange >= 0 ? '+' : ''}${ndxChange || 'N/A'}%)`

  const userPrompt = `Generate today's pre-market briefing for ${today}.

Include these 5 sections:

MARKET DIRECTION: Overall trend assessment — bullish, bearish, or choppy — with 1-2 sentences of context based on overnight futures and Asia/Europe closes.

TOP HEADLINES: 3 most market-moving news items from overnight and premarket. Include the company or event name and rough magnitude of the move.

ECONOMIC CALENDAR: Key data releases today — name, time (ET), and expected market impact (low/medium/high).

KEY LEVELS: SPX and NDX support and resistance levels to watch intraday. Include today's open, yesterday's close, and key technical levels.

TRADE BIAS: One sentence — directional leaning for today's session and the primary risk to that view.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    const data = await response.json()

    if (data.error) {
      res.status(400).json({ error: data.error.message || 'Claude API error' })
      return
    }

    // Extract all text blocks (web search may add multiple text content blocks)
    const brief = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()

    res.status(200).json({
      brief,
      generatedAt: new Date().toISOString(),
      model: data.model || 'claude-sonnet-4',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
