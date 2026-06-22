// api/_lib/tweetAngles.js
// Generates 6 distinct tweet angles for a high-conviction scan result in one
// Claude call — admin picks one to post, rather than generating/regenerating
// a single tweet one at a time. CommonJS only, same pattern as tickerBrief.js.

async function getTweetAngles({ ticker, tradeType, strikeStr, score, grade, dte, target, iv }) {
  const key = process.env.ANTHROPIC_API_KEY || ''
  if (!key) return fallback(ticker, tradeType, score)

  const prompt = `You are a copywriter for a premium options trading scanner. Write 6 DISTINCT tweets about this options setup — each with a different angle/hook, so the person can pick the one that fits their voice today.

Setup:
- Ticker: $${ticker}
- Trade: ${tradeType} ${strikeStr || ''}
- Conviction: ${score}% (Grade ${grade || 'A'})
- DTE: ${dte || 'N/A'}
- Target: ${target || 'N/A'}
- IV: ${iv || 'N/A'}

Each tweet must:
- Be under 260 characters including a trailing URL placeholder "optionsedgeflow.com"
- Sound like a sharp trader spotted something, not a bot — no "I" or "we", write impersonally
- Use max 2 emojis
- Include 2-3 concrete stats from the setup above
- End with 3-5 relevant hashtags on a new line

The 6 angles, one tweet each:
1. "Punchy hook" — opens with a bold one-line callout
2. "Stat-led" — leads with the conviction score / grade as the hook
3. "Story" — frames it as a narrative (why this setup, what's the catalyst)
4. "Question" — opens with a rhetorical question to the reader
5. "Contrarian" — frames against what the crowd might think
6. "Plain data" — minimal flourish, just the numbers and a clean CTA

Respond with ONLY a JSON array of 6 strings, nothing else, no markdown, no explanation:
["tweet 1 text", "tweet 2 text", "tweet 3 text", "tweet 4 text", "tweet 5 text", "tweet 6 text"]`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return fallback(ticker, tradeType, score)
    const data = await res.json()
    const text = (data?.content?.[0]?.text || '').replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback(ticker, tradeType, score)
    return parsed.slice(0, 6).map(t => String(t))
  } catch { return fallback(ticker, tradeType, score) }
}

function fallback(ticker, tradeType, score) {
  // Single generic angle, repeated — better than failing entirely, but
  // honest that this isn't 6 real distinct angles (no API key / API error).
  const base = `$${ticker} ${tradeType || 'setup'} flagged at ${score || '90'}%+ conviction. optionsedgeflow.com\n#options #${ticker}`
  return Array(6).fill(base)
}

module.exports = { getTweetAngles }
