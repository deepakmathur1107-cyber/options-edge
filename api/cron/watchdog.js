// api/cron/watchdog.js
// Runs independently of the scan crons. Checks the freshest scanned_at per
// timeframe; if any is older than its expected cadence (+ grace period),
// sends a Telegram alert so a silent cron failure doesn't go unnoticed.

const EXPECTED_MAX_AGE_MIN = {
  'Quick (5–14 DTE)':       20,   // runs every 15 min — flag if >20 min old
  'Swing (21–45 DTE)':      20,
  'LEAP (90–180 DTE)':      75,   // runs hourly — flag if >75 min old
  'Deep LEAP (180–365 DTE)':75,
}

let _sb = null
function sb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } catch (e) { console.error('[watchdog] supabase init failed:', e.message) }
  }
  return _sb
}

async function notifyTelegram(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return
  try {
    const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.optionsedgeflow.com'
    await fetch(`${host}/api/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
      body: JSON.stringify({ message }),
    })
  } catch (e) { console.error('[watchdog] telegram notify failed:', e.message) }
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET || '__never__'}`
                     || req.headers['x-vercel-cron'] === '1'
  const isManualTrigger = req.query.secret && req.query.secret === process.env.CRON_SECRET
  if (!isVercelCron && !isManualTrigger) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const client = sb()
  if (!client) return res.status(500).json({ error: 'Supabase not configured' })

  // Only check during the active scan window — outside it, staleness is expected.
  const nowUtcHour = new Date().getUTCHours()
  const day = new Date().getUTCDay()   // 0=Sun..6=Sat
  const inWindow = day >= 1 && day <= 5 && nowUtcHour >= 10 && nowUtcHour <= 22
  if (!inWindow) return res.status(200).json({ skipped: true, reason: 'outside scan window' })

  const stale = []
  for (const tf of Object.keys(EXPECTED_MAX_AGE_MIN)) {
    const { data } = await client
      .from('scan_results')
      .select('scanned_at')
      .eq('timeframe', tf)
      .order('scanned_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const ageMin = data ? (Date.now() - new Date(data.scanned_at).getTime()) / 60000 : Infinity
    if (ageMin > EXPECTED_MAX_AGE_MIN[tf]) {
      stale.push({ timeframe: tf, ageMin: Math.round(ageMin) })
    }
  }

  const fixed = [], failed = []

  if (stale.length > 0) {
    const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.optionsedgeflow.com'

    // Self-heal: trigger each stale timeframe directly, same as a normal cron
    // tick would, before deciding whether to bother the person about it.
    for (const s of stale) {
      try {
        const r = await fetch(`${host}/api/cron/scan?tf=${encodeURIComponent(s.timeframe)}`, {
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET || ''}` },
        })
        const j = await r.json().catch(() => null)
        if (r.ok && j && !j.error) fixed.push({ ...s, result: j })
        else failed.push({ ...s, error: j?.error || `HTTP ${r.status}` })
      } catch (e) {
        failed.push({ ...s, error: e.message })
      }
    }

    // Only notify if something genuinely needed a person — a clean self-heal
    // is exactly the kind of thing that shouldn't interrupt anyone's day.
    if (failed.length > 0) {
      const fixedLines  = fixed.length  ? `\n\n✅ Auto-recovered:\n${fixed.map(f=>`• ${f.timeframe} (was ${f.ageMin}min stale)`).join('\n')}` : ''
      const failedLines = `\n\n❌ Could not auto-recover:\n${failed.map(f=>`• ${f.timeframe}: ${f.error}`).join('\n')}`
      await notifyTelegram(`⚠️ Scan watchdog needs you — some timeframes wouldn't self-heal.${fixedLines}${failedLines}\n\nCheck Vercel → Cron Jobs → View Logs, or trigger manually.`)
    }
  }

  return res.status(200).json({
    checked: Object.keys(EXPECTED_MAX_AGE_MIN).length,
    stale: stale.length, fixed: fixed.length, failed: failed.length,
    details: { fixed, failed },
  })
}
