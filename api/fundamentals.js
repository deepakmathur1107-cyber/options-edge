// api/fundamentals.js
// GET /api/fundamentals?ticker=NVDA
// Returns cached fundamentals for a ticker (Supabase → Redis → api-ninjas).
// Auth required (Clerk JWT). Free users get it too — no paywall on fundamentals.
// This counts as one of the 12 Vercel functions.

const { getAuth }           = require('./_lib/auth')
const { getFundamentals }   = require('./_lib/fundamentals')

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://optionsedgeflow.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const { clerkId } = await getAuth(req)
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' })

  const ticker = (req.query.ticker || '').toUpperCase().trim()
  if (!ticker) return res.status(400).json({ error: 'Missing ?ticker= param' })

  // Basic sanity — only valid ticker chars
  if (!/^[A-Z]{1,5}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' })
  }

  try {
    const data = await getFundamentals(ticker)
    if (!data) return res.status(200).json({ ticker, available: false })
    return res.status(200).json({ ticker, available: true, ...data })
  } catch (e) {
    console.error('[fundamentals] handler error:', e.message)
    return res.status(500).json({ error: 'Failed to fetch fundamentals' })
  }
}
