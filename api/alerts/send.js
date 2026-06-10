/**
 * api/alerts/send.js — Vercel Serverless Function (Cron + Manual)
 *
 * Cron: "0 14 * * 1-5"  (10 AM ET weekdays)
 * Manual: GET /api/alerts/trigger?secret=CRON_SECRET
 */

const { createClient } = require('@supabase/supabase-js')

const TRADIER_BASE  = 'https://api.tradier.com/v1'
const TRADIER_TOKEN = process.env.TRADIER_TOKEN

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'AMZN', 'META', 'IWM', 'AAPL']

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSymbols(raw) {
  if (!raw) return []
  const s = typeof raw === 'string' ? raw.trim() : String(raw)
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      return Array.isArray(arr)
        ? arr.map(x => String(x).replace(/['"]/g, '').trim().toUpperCase()).filter(Boolean)
        : []
    } catch { /* fall through */ }
  }
  return s.split(',').map(x => x.replace(/['"\[\]]/g, '').trim().toUpperCase()).filter(Boolean)
}

function pickExpiry(dates) {
  const today = new Date()
  const arr = Array.isArray(dates) ? dates : [dates]
  const withDTE = arr.map(d => ({
    d,
    dte: Math.round((new Date(d + 'T12:00:00') - today) / 86400000)
  }))
  const ideal = withDTE.filter(x => x.dte >= 14 && x.dte <= 45)
  if (ideal.length) return ideal[0]
  const ok = withDTE.filter(x => x.dte >= 7 && x.dte <= 60)
  if (ok.length) return ok[0]
  const future = withDTE.filter(x => x.dte >= 3)
  return future.length ? future[0] : { d: arr[0], dte: 0 }
}

function gradeFromScore(score) {
  if (score >= 75) return { letter: 'A', color: '#00ff88' }
  if (score >= 60) return { letter: 'B', color: '#00c8ff' }
  return             { letter: 'C', color: '#ff9500' }
}

function setupReason(a) {
  const parts = []
  if (a.dirAligned)   parts.push(`aligned with today\'s ${a.chgPct > 0 ? 'rally' : 'pullback'}`)
  if (a.ivNote)       parts.push(a.ivNote)
  if (a.deltaNote)    parts.push(a.deltaNote)
  if (a.spreadNote)   parts.push(a.spreadNote)
  return parts.length ? parts.join(' · ') : 'liquid near-the-money contract'
}

// ── Tradier fetches ───────────────────────────────────────────────────────────

async function fetchQuote(symbol) {
  try {
    const r = await fetch(
      `${TRADIER_BASE}/markets/quotes?symbols=${symbol}&greeks=false`,
      { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
    )
    if (!r.ok) return null
    const q = (await r.json())?.quotes?.quote
    if (!q) return null
    return {
      price:  parseFloat(q.last || q.prevclose || 0),
      chgPct: parseFloat(q.change_percentage || 0),
      chg:    parseFloat(q.change || 0),
    }
  } catch { return null }
}

async function fetchChainWithExpiry(symbol) {
  try {
    const expRes = await fetch(
      `${TRADIER_BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=false`,
      { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
    )
    if (!expRes.ok) return { chain: [], dte: 0, expiry: '' }
    const expirations = (await expRes.json())?.expirations?.date
    if (!expirations?.length) return { chain: [], dte: 0, expiry: '' }
    const picked = pickExpiry(expirations)

    const chainRes = await fetch(
      `${TRADIER_BASE}/markets/options/chains?symbol=${symbol}&expiration=${picked.d}&greeks=true`,
      { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
    )
    if (!chainRes.ok) return { chain: [], dte: picked.dte, expiry: picked.d }
    const chain = (await chainRes.json())?.options?.option || []
    return { chain, dte: picked.dte, expiry: picked.d }
  } catch (e) {
    console.error(`fetchChain ${symbol}:`, e.message)
    return { chain: [], dte: 0, expiry: '' }
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreContract(c, stockPrice, stockChgPct, dte) {
  const delta  = Math.abs(c?.greeks?.delta ?? 0)
  const iv     = c?.greeks?.smv_vol        ?? 0
  const oi     = c?.open_interest          ?? 0
  const volume = c?.volume                 ?? 0
  const bid    = c?.bid                    ?? 0
  const ask    = c?.ask                    ?? 0
  const mid    = (bid + ask) / 2
  const isPut  = c?.option_type === 'put'
  const isCall = c?.option_type === 'call'
  const pctOTM = stockPrice > 0
    ? Math.abs((c.strike - stockPrice) / stockPrice) * 100
    : 99

  // Hard disqualifiers
  if (mid    < 0.15)            return null
  if (delta  < 0.15)            return null   // too far OTM
  if (delta  > 0.85)            return null   // too deep ITM
  if (ask    <= 0 || bid <= 0)  return null
  if ((ask - bid) > mid * 0.45) return null   // illiquid spread
  if (pctOTM > 8)               return null   // more than 8% OTM

  // Direction alignment
  const strongUp   = stockChgPct >  1.0
  const mildUp     = stockChgPct >  0.2
  const mildDown   = stockChgPct < -0.2
  const strongDown = stockChgPct < -1.0

  let dirBonus = 0
  let dirAligned = false
  if (isPut  && strongDown) { dirBonus =  20; dirAligned = true }
  else if (isPut  && mildDown)   { dirBonus =  10; dirAligned = true }
  else if (isCall && strongUp)   { dirBonus =  20; dirAligned = true }
  else if (isCall && mildUp)     { dirBonus =  10; dirAligned = true }
  else if (isPut  && strongUp)   { dirBonus = -30 }
  else if (isCall && strongDown) { dirBonus = -30 }

  // DTE score — sweet spot 21-35 DTE
  const dteScore = dte >= 21 && dte <= 35 ? 15
                 : dte >= 14 && dte <= 45 ? 10
                 : dte >= 7              ?  5 : 0

  // Delta score — sweet spot 0.35-0.55 (near ATM)
  const deltaScore = delta >= 0.35 && delta <= 0.55 ? 25
                   : delta >= 0.25 && delta <= 0.65 ? 15 : 8

  // IV score — moderate IV ideal, very high IV = risk
  const ivScore = iv >= 0.20 && iv <= 0.45 ? 20
                : iv >= 0.15 && iv <= 0.60 ? 12
                : iv > 0                   ?  5 : 0

  // Liquidity — OI and volume
  const liqScore = Math.min(15, Math.round(Math.log1p(oi + volume) * 1.8))

  // Spread tightness
  const spreadRatio = (ask - bid) / mid
  const spreadScore = spreadRatio < 0.08 ? 10
                    : spreadRatio < 0.15 ?  6
                    : spreadRatio < 0.25 ?  3 : 0

  const raw = deltaScore + ivScore + liqScore + spreadScore + dteScore + dirBonus
  const score = Math.min(95, Math.max(0, raw))

  // Annotation notes for email "why" line
  const ivNote    = iv >= 0.35 ? 'elevated IV' : iv >= 0.20 ? 'moderate IV' : ''
  const deltaNote = delta >= 0.40 && delta <= 0.55 ? 'near-ATM strike' : ''
  const spreadNote = spreadRatio < 0.08 ? 'tight spread' : ''

  return {
    score, dirAligned, chgPct: stockChgPct,
    ivNote, deltaNote, spreadNote,
    // Pass-through for breakeven calc
    isPut, isCall, stockPrice,
    delta, iv, mid, bid, ask, oi,
  }
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildEmailHtml(alerts, marketCtx) {
  const dateStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })

  // Market context header
  const ctxHtml = marketCtx ? `
    <div style="background:#0d2030;border:1px solid #1a2e3e;border-radius:6px;padding:12px 16px;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap">
      ${marketCtx.spy  ? `<span style="font-family:monospace;font-size:11px;color:#c8d8e8"><span style="color:#4a7a8a">SPY</span> $${marketCtx.spy.price.toFixed(2)} <span style="color:${marketCtx.spy.chgPct>=0?'#00ff88':'#ff4466'}">${marketCtx.spy.chgPct>=0?'+':''}${marketCtx.spy.chgPct.toFixed(2)}%</span></span>` : ''}
      ${marketCtx.qqq  ? `<span style="font-family:monospace;font-size:11px;color:#c8d8e8"><span style="color:#4a7a8a">QQQ</span> $${marketCtx.qqq.price.toFixed(2)} <span style="color:${marketCtx.qqq.chgPct>=0?'#00ff88':'#ff4466'}">${marketCtx.qqq.chgPct>=0?'+':''}${marketCtx.qqq.chgPct.toFixed(2)}%</span></span>` : ''}
      <span style="font-family:monospace;font-size:11px;color:#c8d8e8"><span style="color:#4a7a8a">BIAS</span> <span style="color:${marketCtx.biasColor}">${marketCtx.bias}</span></span>
    </div>` : ''

  // Alert rows
  const rows = alerts.map(a => {
    const grade   = gradeFromScore(a.score)
    const reason  = setupReason(a)
    const stopVal = (a.mid * 0.50).toFixed(2)
    const tgtVal  = (a.mid * 1.80).toFixed(2)
    const otmPct  = a.stockPrice > 0
      ? Math.abs((a.strike - a.stockPrice) / a.stockPrice * 100).toFixed(1)
      : '—'
    const bePrice = a.isPut
      ? (a.strike - a.mid).toFixed(2)
      : (a.strike + a.mid).toFixed(2)

    return `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top">
        <div style="font-weight:700;color:#00ff88;font-family:monospace;font-size:13px">${a.symbol}</div>
        <div style="font-size:10px;color:#4a7a8a;margin-top:2px">@ $${a.stockPrice?.toFixed(2) ?? '—'}</div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top">
        <div style="color:#c8d8e8;font-family:monospace;font-size:12px;font-weight:600">${a.type} ${a.strike}</div>
        <div style="color:#4a7a8a;font-size:10px;margin-top:2px">${a.dte} DTE · ${otmPct}% OTM</div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top;text-align:center">
        <div style="display:inline-block;background:${grade.color}22;border:1px solid ${grade.color}55;border-radius:4px;padding:3px 10px">
          <span style="font-family:monospace;font-weight:700;font-size:15px;color:${grade.color}">${grade.letter}</span>
        </div>
      </td>
      <td style="padding:12px;border-bottom:1px solid #0d2030;vertical-align:top">
        <div style="color:#c8d8e8;font-family:monospace;font-size:12px;font-weight:600">$${a.mid.toFixed(2)}</div>
        <div style="font-size:10px;color:#4a7a8a;margin-top:2px">Stop $${stopVal} · Target $${tgtVal}</div>
      </td>
    </tr>
    <tr>
      <td colspan="4" style="padding:4px 12px 12px;border-bottom:1px solid #1a2e3e">
        <div style="font-size:10px;color:#4a7a8a;font-style:italic">
          Break-even: $${bePrice} stock price · ${reason}
        </div>
      </td>
    </tr>`
  }).join('')

  return `
  <div style="background:#090e14;color:#c8d8e8;font-family:Inter,Arial,sans-serif;padding:28px 24px;max-width:620px;margin:0 auto">

    <div style="margin-bottom:20px">
      <h1 style="font-family:'Bebas Neue',Impact,sans-serif;color:#00ff88;letter-spacing:3px;margin:0 0 4px 0;font-size:28px">OPTIONS EDGE ALERT</h1>
      <p style="color:#4a7a8a;font-size:11px;font-family:monospace;margin:0">${dateStr} ET · ${alerts.length} setup${alerts.length>1?'s':''} found</p>
    </div>

    ${ctxHtml}

    <table style="width:100%;border-collapse:collapse;background:#0d1a26;border:1px solid #1a2e3e;border-radius:6px;overflow:hidden">
      <thead>
        <tr style="background:#0a1520">
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">SYMBOL</th>
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">CONTRACT</th>
          <th style="padding:10px 12px;text-align:center;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">GRADE</th>
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#4a7a8a;font-family:monospace;letter-spacing:1px">PREMIUM</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="margin-top:20px;padding:12px 16px;background:#0d1a26;border:1px solid #1a2e3e;border-radius:6px">
      <div style="font-size:10px;color:#4a7a8a;font-family:monospace;line-height:1.8">
        <strong style="color:#c8d8e8">Grade guide:</strong>
        <span style="color:#00ff88;margin-left:8px">A = strong setup</span>
        <span style="color:#00c8ff;margin-left:8px">B = good setup</span>
        <span style="color:#ff9500;margin-left:8px">C = borderline</span><br>
        Stop = -50% of premium · Target = +80% of premium · Not financial advice.
      </div>
    </div>

    <p style="color:#2a4a5a;font-size:10px;font-family:monospace;margin-top:16px;text-align:center">
      <a href="https://optionsedgeflow.com/app" style="color:#00c8ff;text-decoration:none">Manage preferences at OptionsEdgeFlow</a>
      &nbsp;·&nbsp; You're receiving this because you enabled email alerts.
    </p>
  </div>`
}

// ── SMS builder ───────────────────────────────────────────────────────────────

function buildSmsText(alerts, marketCtx) {
  const bias = marketCtx ? ` · ${marketCtx.bias}` : ''
  const lines = alerts.slice(0, 3).map(a => {
    const grade = gradeFromScore(a.score)
    return `[${grade.letter}] ${a.symbol} ${a.type} ${a.strike} (${a.dte}DTE) $${a.mid.toFixed(2)}`
  })
  return `OptionsEdge${bias}\n${lines.join('\n')}\nStop -50% / Target +80%\noptionsedgeflow.com/app`
}

// ── Twilio SMS ────────────────────────────────────────────────────────────────

async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from  = process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) { console.warn('SMS skipped: Twilio env vars not set'); return false }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:  'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  })
  if (!res.ok) { console.error('Twilio error:', await res.json().catch(() => ({}))); return false }
  return true
}

// ── Resend email ──────────────────────────────────────────────────────────────

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL || 'alerts@optionsedgeflow.com',
      to, subject, html,
    }),
  })
  if (!res.ok) {
    console.error('Resend error:', JSON.stringify(await res.json().catch(() => ({}))))
    return false
  }
  return true
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-cron-secret')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST only' })
  }

  const secret = req.query?.secret ||
    req.headers['x-cron-secret'] ||
    (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const scannedAt = new Date().toISOString()

  try {
    // 1. Fetch users with alerts enabled
    const { data: users, error: usersErr } = await supabase
      .from('alert_prefs')
      .select('*')
      .or('email_alerts.eq.true,sms_on.eq.true')

    if (usersErr) return res.status(500).json({ error: usersErr.message })
    if (!users?.length) return res.status(200).json({ sent: 0, scannedAt, note: 'No users with alerts enabled' })

    console.log(`Users: ${users.length}`)

    // 2. Collect all unique symbols
    const allSymbols = new Set(DEFAULT_SYMBOLS)
    for (const u of users) parseSymbols(u.symbols).forEach(s => allSymbols.add(s))
    const symbols = [...allSymbols]
    console.log('Symbols:', symbols)

    // 3. Fetch market context (SPY + QQQ for header)
    const [spyCtx, qqqCtx] = await Promise.all([fetchQuote('SPY'), fetchQuote('QQQ')])
    const spxChg = spyCtx?.chgPct ?? 0
    const bias   = spxChg >  0.5 ? 'BULLISH'
                 : spxChg < -0.5 ? 'BEARISH' : 'NEUTRAL'
    const marketCtx = {
      spy:       spyCtx,
      qqq:       qqqCtx,
      bias,
      biasColor: bias === 'BULLISH' ? '#00ff88' : bias === 'BEARISH' ? '#ff4466' : '#ff9500',
    }
    console.log(`Market: SPY ${spxChg.toFixed(2)}% → ${bias}`)

    // 4. Scan each symbol
    const alertsBySymbol = {}
    for (const sym of symbols) {
      const [{ chain, dte, expiry }, quote] = await Promise.all([
        fetchChainWithExpiry(sym),
        fetchQuote(sym),
      ])
      const stockPrice = quote?.price   ?? 0
      const chgPct     = quote?.chgPct  ?? 0
      console.log(`${sym} $${stockPrice.toFixed(2)} chg:${chgPct.toFixed(2)}% dte:${dte}`)

      const scored = chain
        .map(c => {
          const s = scoreContract(c, stockPrice, chgPct, dte)
          if (!s || s.score < 45) return null
          return {
            symbol:     sym,
            type:       c.option_type === 'call' ? 'CALL' : 'PUT',
            strike:     c.strike,
            expiry,
            dte,
            score:      s.score,
            mid:        s.mid,
            stockPrice,
            chgPct,
            // annotation fields
            dirAligned: s.dirAligned,
            ivNote:     s.ivNote,
            deltaNote:  s.deltaNote,
            spreadNote: s.spreadNote,
            isPut:      s.isPut,
            isCall:     s.isCall,
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)   // max 2 per symbol

      if (scored.length) alertsBySymbol[sym] = scored
    }

    // 5. Notify each user
    let sent = 0
    for (const user of users) {
      const watchlist = user.symbols ? parseSymbols(user.symbols) : DEFAULT_SYMBOLS
      const minScore  = user.min_edge_score ?? 50

      const userAlerts = watchlist
        .flatMap(sym => alertsBySymbol[sym] || [])
        .filter(a => a.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)

      if (!userAlerts.length) {
        console.log(`No alerts for ${user.clerk_user_id}`)
        continue
      }

      const grade  = gradeFromScore(userAlerts[0].score)
      const subject = `OptionsEdge: ${userAlerts.length} ${grade.letter}-grade alert${userAlerts.length > 1 ? 's' : ''} today`

      let notified = false
      if (user.email_alerts && user.alert_email) {
        const ok = await sendEmail(user.alert_email, subject, buildEmailHtml(userAlerts, marketCtx))
        if (ok) { notified = true; console.log(`Email → ${user.alert_email}`) }
        else    { console.error(`Email FAILED → ${user.alert_email}`) }
      }
      if (user.sms_on && user.phone_number) {
        const ok = await sendSms(user.phone_number, buildSmsText(userAlerts, marketCtx))
        if (ok) { notified = true; console.log(`SMS → ${user.phone_number}`) }
      }
      if (notified) sent++
    }

    return res.status(200).json({ sent, symbols, bias, scannedAt })

  } catch (e) {
    console.error('alerts/send fatal:', e)
    return res.status(500).json({ error: e.message })
  }
}
