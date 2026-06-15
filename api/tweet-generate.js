const Anthropic = require("@anthropic-ai/sdk");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const { setup } = req.body;
  if (!setup) return res.status(400).json({ error: "Missing setup" });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are a copywriter for OptionsEdgeFlow, a premium options trading scanner at optionsedgeflow.com.

Write a single tweet (max 260 chars including the URL) about this options setup that:
1. Opens with a punchy hook about the trade — make it feel like a real trader spotted something
2. Shows 2–3 key stats inline (ticker, setup type, edge score, DTE, or IV rank — pick the most compelling)
3. Ends with a subtle tease that makes people want to see more setups like this, with the URL: optionsedgeflow.com
4. Includes 4–6 relevant hashtags on a new line at the end

Trade details:
- Ticker: ${setup.ticker}
- Setup: ${setup.setup || setup.strategy || "Options Spread"}
- Edge Score: ${setup.edgeScore || setup.edge_score}%
- DTE: ${setup.dte} days
- IV Rank: ${setup.ivRank || setup.iv_rank || "N/A"}
- Direction: ${setup.direction || "Neutral"}
- Profit Target: ${setup.profitTarget || setup.profit_target || "80"}%

Rules:
- No emojis overload — max 2 emojis
- Sound like a sharp trader, not a bot
- Never say "I" or "we" — write in 3rd person or impersonally
- Return ONLY the tweet text, nothing else`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const tweet = message.content?.find((b) => b.type === "text")?.text?.trim();
  return res.status(200).json({ tweet });
};
