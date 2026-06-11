// api/_lib/tickerBrief.js
// Generates a short AI brief for a ticker using price + S/R context.
// CommonJS only.

async function getTickerBrief({ ticker, price, chgPct, s1, r1, ma200, ma50, position, iv, dte, tradeType, score }) {
  const key = process.env.ANTHROPIC_API_KEY || ''
  if (!key) return fallback(ticker, chgPct)

  const posLabel = position === 'at_resistance' ? 'testing key resistance'
                 : position === 'at_support'    ? 'testing key support'
                 : 'trading mid-range'

  const maLine = ma200
    ? `50-day MA: $${ma50 || 'N/A'} | 200-day MA: $${ma200} (price is ${price > ma200 ? 'ABOVE' : 'BELOW'} long-term trend)`
    : 'Moving averages: N/A'

  const prompt = `You are a concise options trading analyst. Respond ONLY with valid JSON, no markdown, no extra text.

$${ticker} real-time data:
- Price: $${price} (${chgPct >= 0 ? '+' : ''}${parseFloat(chgPct).toFixed(2)}% today)
- Support S1: $${s1} | Resistance R1: $${r1}
- ${maLine}
- Price position: ${posLabel}
- Implied Volatility: ${iv ? (parseFloat(iv) * 100).toFixed(0) + '%' : 'N/A'}
- Scan: ${tradeType} | Conviction: ${score}% | DTE: ${dte}

Return this exact JSON:
{
  "summary": "2 sentences max. What is the stock doing technically and what does it mean for the options trade right now.",
  "catalyst": "Most likely specific near-term catalyst — earnings date if known, macro event, sector move, technical breakout/breakdown level, or 'No clear catalyst identified'.",
  "bias": "Bullish" or "Bearish" or "Neutral",
  "tone": "bullish" or "bearish" or "neutral" or "caution"
}`

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
        max_tokens: 250,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return fallback(ticker, chgPct)
    const data   = await res.json()
    const text   = (data?.content?.[0]?.text || '').replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text)
    return {
      summary:  parsed.summary  || '',
      catalyst: parsed.catalyst || 'No clear catalyst identified',
      bias:     parsed.bias     || (chgPct >= 0 ? 'Bullish' : 'Bearish'),
      tone:     parsed.tone     || 'neutral',
    }
  } catch { return fallback(ticker, chgPct) }
}

function fallback(ticker, chgPct) {
  return {
    summary:  `$${ticker} is ${parseFloat(chgPct) >= 0 ? 'up' : 'down'} ${Math.abs(parseFloat(chgPct)).toFixed(2)}% today. Review key levels before entering.`,
    catalyst: 'No clear catalyst identified',
    bias:     parseFloat(chgPct) >= 0 ? 'Bullish' : 'Bearish',
    tone:     'neutral',
  }
}

module.exports = { getTickerBrief }
