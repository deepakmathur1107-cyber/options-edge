/**
 * api/alerts/send.js  — Vercel Serverless Function (internal / cron use)
 *
 * POST /api/alerts/send
 * Header: x-cron-secret: <CRON_SECRET>
 */

const { Resend } = require('resend')
const { createClient } = require('@supabase/supabase-js')

const resend = new Resend(process.env.RESEND_API_KEY)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TRADIER_TOKEN = process.env.TRADIER_API_TOKEN
const TRADIER_BASE = 'https://sandbox.tradier.com/v1'
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'onboarding@resend.dev'

async function fetchQuote(symbol) {
  const res = await fetch(
    `${TRADIER_BASE}/markets/quotes?symbols=${symbol}&greeks=false`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  )
  const json = await res.json()
  return json?.quotes?.quote || null
}

async function fetchNearestExpiration(symbol) {
  const res = await fetch(
    `${TRADIER_BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=false`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  )
  const json = await res.json()
  const dates = json?.expirations?.date || []
  const arr = Array.isArray(dates) ? dates : [dates]
  const today = Date.now()
  const filtered = arr.filter(d => {
    const dte = (new Date(d) - today) / 86_400_000
    return dte >= 7 && dte <= 45
  })
  return filtered[0] || arr[1] || arr[0] || null
}

async function fetchOptionsChain(symbol, expiration) {
  const res = await fetch(
    `${TRADIER_BASE}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  )
  const json = await res.json()
  const options = json?.options?.option || []
  return Array.isArray(options) ? options : [options]
}

function computeEdgeScore(option) {
  const { greeks, volume, open_interest, bid, ask } = option
  if (!greeks || bid == null || ask == null) return null
  const mid = (bid + ask) / 2
  const spread = ask - bid
  const spreadPct = mid > 0 ? spread / mid : 1
  const delta = Math.abs(greeks.delta || 0)
  const theta = Math.abs(greeks.theta || 0)
  const iv = greeks.smv_vol || greeks.bid_iv || 0
  const oi = open_interest || 0
  const vol = volume || 0
  const deltaScore = delta >= 0.2 && delta <= 0.4 ? 20 : delta >= 0.1 && delta <= 0.5 ? 10 : 0
  const thetaScore = mid > 0 ? Math.min(20, (theta / mid) * 200) : 0
  const spreadScore = spreadPct < 0.05 ? 20 : spreadPct < 0.1 ? 12 : spreadPct < 0.2 ? 6 : 0
  const liquidityScore = oi > 500 && vol > 100 ? 20 : oi > 100 ? 10 : 0
  const ivScore = iv > 0.15 && iv < 0.6 ? 20 : 0
  return Math.round(deltaScore + thetaScore + spreadScore + liquidityScore + ivScore)
}

function buildEmailHtml(contracts) {
  const rows = contracts.map(c => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">${c.symbol}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">${c.type.toUpperCase()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">$${c.strike}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">${c.expiration}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">$${c.mid}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d;color:#10b981;font-weight:600">${c.edgeScore}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif;color:#e4e4e7">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:12px;overflow:hidden">
        <tr><td style="padding:28px 32px;border-bottom:1px solid #222">
          <span style="font-size:20px;font-weight:700">⚡ Options <span style="color:#10b981">Edge</span> Alert</span>
        </td></tr>
        <tr><td style="padding:24px 32px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
            <thead><tr style="color:#71717a;text-transform:uppercase;font-size:11px">
              <th style="padding:8px 12px;text-align:left">Symbol</th>
              <th style="padding:8px 12px;text-align:left">Type</th>
              <th style="padding:8px 12px;text-align:left">Strike</th>
              <th style="padding:8px 12px;text-align:left">Exp</th>
              <th style="padding:8px 12px;text-align:left">Mid</th>
              <th style="padding:8px 12px;text-align:left">Score</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #222;text-align:center">
          <a href="https://options-edge-theta.vercel.app/app"
             style="display:inline-block;padding:10px 24px;background:#10b981;color:#000;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px">
            Open Dashboard →
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #1a1a1a;text-align:center">
          <p style="margin:0;color:#52525b;font-size:11px">Options Edge · Not financial advice.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cron-secret']
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { data: prefs, error: prefsError } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('email_alerts', true)

    if (prefsError) throw prefsError
    if (!prefs?.length) return res.status(200).json({ sent: 0, message: 'No subscribers' })

    const allSymbols = [...new Set(prefs.flatMap(p => p.symbols || ['SPY', 'QQQ']))]
    const scanResults = {}

    await Promise.all(allSymbols.map(async symbol => {
      try {
        const [quote, expiration] = await Promise.all([
          fetchQuote(symbol),
          fetchNearestExpiration(symbol),
        ])
        if (!quote || !expiration) return
        const chain = await fetchOptionsChain(symbol, expiration)
        const contracts = chain
          .map(o => ({ ...o, edgeScore: computeEdgeScore(o) }))
          .filter(o => o.edgeScore !== null)
          .sort((a, b) => b.edgeScore - a.edgeScore)
          .slice(0, 5)
          .map(o => ({
            symbol,
            type: o.option_type,
            strike: o.strike,
            expiration: o.expiration_date,
            mid: +((o.bid + o.ask) / 2).toFixed(2),
            edgeScore: o.edgeScore,
          }))
        scanResults[symbol] = contracts
      } catch {}
    }))

    let sent = 0
    await Promise.all(prefs.map(async pref => {
      if (!pref.alert_email) return
      const minScore = pref.min_edge_score || 50
      const userSymbols = Array.isArray(pref.symbols) 
      ? pref.symbols 
      : typeof pref.symbols === 'string' 
      ? pref.symbols.split(',').map(s => s.trim()).filter(Boolean)
      : ['SPY', 'QQQ']
      const matching = userSymbols.flatMap(s => scanResults[s] || []).filter(c => c.edgeScore >= minScore)
      if (!matching.length) return

      await resend.emails.send({
        from: FROM_EMAIL,
        to: pref.alert_email,
        subject: `⚡ Options Edge: ${matching.length} high-edge contract${matching.length > 1 ? 's' : ''} found`,
        html: buildEmailHtml(matching),
      })
      sent++
    }))

    return res.status(200).json({ sent, scannedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[alerts/send]', err)
    return res.status(500).json({ error: err.message })
  }
}
