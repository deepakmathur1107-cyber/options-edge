/**
 * api/alerts/send.js  — Vercel Serverless Function (internal / cron use)
 *
 * POST /api/alerts/send
 * Header: x-cron-secret: <CRON_SECRET>
 *
 * Scans Tradier for liquid options contracts and emails subscribers.
 */

const { Resend } = require('resend')
const { createClient } = require('@supabase/supabase-js')

const resend = new Resend(process.env.RESEND_API_KEY)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TRADIER_TOKEN = process.env.TRADIER_TOKEN
const TRADIER_BASE = process.env.TRADIER_MODE === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1';
const FROM_EMAIL    = process.env.ALERT_FROM_EMAIL || 'onboarding@resend.dev'

// ─── Tradier helpers ──────────────────────────────────────────────────────────

async function tradierGet(path) {
  const res = await fetch(`${TRADIER_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${TRADIER_TOKEN}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Tradier ${res.status} ${path}`)
  return res.json()
}

async function getQuote(symbol) {
  const json = await tradierGet(`/markets/quotes?symbols=${symbol}&greeks=false`)
  return json?.quotes?.quote || null
}

async function getNearestExpiration(symbol) {
  const json = await tradierGet(
    `/markets/options/expirations?symbol=${symbol}&includeAllRoots=false`
  )
  const dates = json?.expirations?.date || []
  const arr   = Array.isArray(dates) ? dates : [dates]
  const today = Date.now()
  // Pick first expiration at least 1 day out
  const valid = arr.filter(d => (new Date(d) - today) / 86_400_000 >= 1)
  return valid[0] || arr[0] || null
}

async function getChain(symbol, expiration) {
  const json = await tradierGet(
    `/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`
  )
  const opts = json?.options?.option || []
  return Array.isArray(opts) ? opts : [opts]
}

// ─── Contract selection ───────────────────────────────────────────────────────
// Pick the 3 most liquid contracts with a valid bid/ask.
// In production (live Tradier), Greeks will be real and we can add delta scoring.
// For sandbox, we just select by open interest + volume.

function selectContracts(chain, symbol) {
  return chain
    .filter(o => o.bid > 0 && o.ask > 0 && (o.open_interest > 0 || o.volume > 0))
    .sort((a, b) => {
      const scoreA = (a.open_interest || 0) + (a.volume || 0) * 2
      const scoreB = (b.open_interest || 0) + (b.volume || 0) * 2
      return scoreB - scoreA
    })
    .slice(0, 3)
    .map(o => ({
      symbol,
      type:       o.option_type,
      strike:     o.strike,
      expiration: o.expiration_date,
      bid:        o.bid,
      ask:        o.ask,
      mid:        +((o.bid + o.ask) / 2).toFixed(2),
      volume:     o.volume     || 0,
      oi:         o.open_interest || 0,
      iv:         o.greeks?.smv_vol || o.greeks?.mid_iv || null,
      delta:      o.greeks?.delta  || null,
      edgeScore:  50, // neutral score — real scoring needs live Greeks
    }))
}

// ─── Email template ───────────────────────────────────────────────────────────

function buildEmailHtml(contracts) {
  const rows = contracts.map(c => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">${c.symbol}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">${c.type.toUpperCase()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">$${c.strike}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">${c.expiration}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">$${c.mid}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2d2d2d">
        OI: ${c.oi.toLocaleString()} · Vol: ${c.volume.toLocaleString()}
      </td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif;color:#e4e4e7">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0"
             style="background:#111;border:1px solid #222;border-radius:12px;overflow:hidden">

        <tr><td style="padding:24px 32px;border-bottom:1px solid #222">
          <span style="font-size:20px;font-weight:700;letter-spacing:-0.5px">
            ⚡ Options <span style="color:#10b981">Edge</span> — Daily Scan
          </span>
        </td></tr>

        <tr><td style="padding:24px 32px">
          <p style="margin:0 0 16px;color:#a1a1aa;font-size:14px">
            Most liquid contracts found in today's scan.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="color:#71717a;text-transform:uppercase;font-size:11px;letter-spacing:0.05em">
                <th style="padding:8px 12px;text-align:left">Symbol</th>
                <th style="padding:8px 12px;text-align:left">Type</th>
                <th style="padding:8px 12px;text-align:left">Strike</th>
                <th style="padding:8px 12px;text-align:left">Exp</th>
                <th style="padding:8px 12px;text-align:left">Mid</th>
                <th style="padding:8px 12px;text-align:left">Activity</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </td></tr>

        <tr><td style="padding:20px 32px;border-top:1px solid #222;text-align:center">
          <a href="https://options-edge-theta.vercel.app/app"
             style="display:inline-block;padding:10px 24px;background:#10b981;
                    color:#000;text-decoration:none;border-radius:8px;
                    font-weight:600;font-size:13px">
            Open Dashboard →
          </a>
        </td></tr>

        <tr><td style="padding:16px 32px;border-top:1px solid #1a1a1a;text-align:center">
          <p style="margin:0;color:#52525b;font-size:11px">
            Options Edge ·
            <a href="https://options-edge-theta.vercel.app/app/settings/alerts"
               style="color:#52525b">Manage alerts</a>
            · Not financial advice.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const secret = req.headers['x-cron-secret']
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // 1. Get subscribers with email alerts enabled
    const { data: prefs, error: prefsError } = await supabase
      .from('alert_prefs')
      .select('*')
      .eq('email_alerts', true)

    if (prefsError) throw prefsError
    if (!prefs?.length) {
      return res.status(200).json({ sent: 0, message: 'No subscribers' })
    }

    // 2. Collect unique symbols across all subscribers
    const allSymbols = [...new Set(
      prefs.flatMap(p => {
        const s = p.symbols
        if (Array.isArray(s)) return s
        if (typeof s === 'string') {
          try { return JSON.parse(s) } catch { return s.split(',').map(x => x.trim()) }
        }
        return ['SPY', 'QQQ']
      })
    )]

    // 3. Scan each symbol
    const scanResults = {}
    await Promise.all(allSymbols.map(async symbol => {
      try {
        const [quote, expiration] = await Promise.all([
          getQuote(symbol),
          getNearestExpiration(symbol),
        ])
        if (!quote || !expiration) return
        const chain     = await getChain(symbol, expiration)
        const contracts = selectContracts(chain, symbol)
        if (contracts.length > 0) {
          scanResults[symbol] = contracts
        }
      } catch (e) {
        console.error(`Scan failed for ${symbol}:`, e.message)
      }
    }))

    // 4. Send emails to matching subscribers
    let sent = 0
    await Promise.all(prefs.map(async pref => {
      if (!pref.alert_email) return

      const userSymbols = Array.isArray(pref.symbols)
        ? pref.symbols
        : typeof pref.symbols === 'string'
          ? (() => { try { return JSON.parse(pref.symbols) } catch { return pref.symbols.split(',').map(s => s.trim()) } })()
          : ['SPY', 'QQQ']

      const matching = userSymbols.flatMap(s => scanResults[s] || [])
      if (!matching.length) return

      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      pref.alert_email,
        subject: `⚡ Options Edge: ${matching.length} contract${matching.length > 1 ? 's' : ''} found`,
        html:    buildEmailHtml(matching),
      })
      sent++
    }))

    return res.status(200).json({
      sent,
      symbols:   allSymbols,
      scannedAt: new Date().toISOString(),
    })

  } catch (err) {
    console.error('[alerts/send]', err)
    return res.status(500).json({ error: err.message })
  }
}
