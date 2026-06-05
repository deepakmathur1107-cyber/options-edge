/**
 * src/pages/AlertSettings.jsx
 *
 * Full-page alert preferences.
 * Route: /app/settings/alerts
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

const SYMBOLS = ['SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'META']

const DEFAULT_PREFS = {
  email_alerts:   false,
  alert_email:    '',
  min_edge_score: 50,
  symbols:        ['SPY', 'QQQ'],
}

const iSt = {
  width: '100%',
  background: '#0d1a26',
  border: '1px solid #1a2e3e',
  borderRadius: 4,
  color: '#c8d8e8',
  padding: '9px 12px',
  fontSize: 12,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

export default function AlertSettings({ getToken }) {
  const [prefs,   setPrefs]   = useState(DEFAULT_PREFS)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch('/api/user/prefs', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setPrefs({
          email_alerts:   data.prefs.email_alerts   ?? false,
          alert_email:    data.prefs.alert_email     ?? '',
          min_edge_score: data.prefs.min_edge_score  ?? 50,
          symbols:        data.prefs.symbols         ?? ['SPY', 'QQQ'],
        })
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [getToken])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/user/prefs', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function toggleSymbol(sym) {
    setPrefs(p => ({
      ...p,
      symbols: p.symbols.includes(sym)
        ? p.symbols.filter(s => s !== sym)
        : [...p.symbols, sym],
    }))
  }

  const C = {
    green: '#00ff88', blue: '#00c8ff', orange: '#ff9500',
    red: '#ff4466', dim: '#4a7a8a', card: '#0d1a26',
    bg: '#090e14', border: '#1a2e3e', text: '#c8d8e8',
  }

  return (
    <div style={{
      background: c.bg, minHeight: '100vh',
      fontFamily: "'IBM Plex Mono', monospace",
      color: C.text, paddingBottom: 40,
    }}>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${C.border}`,
        padding: '12px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
        background: '#06090f',
      }}>
        <Link to="/app" style={{
          color: C.dim, textDecoration: 'none', fontSize: 11,
          border: `1px solid ${C.border}`, padding: '4px 10px',
          borderRadius: 3, letterSpacing: 0.5,
        }}>
          ← BACK
        </Link>
        <span style={{
          fontFamily: "'Bebas Neue', sans-serif",
          fontSize: 20, letterSpacing: 3, color: C.green,
        }}>
          OPTIONS EDGE
        </span>
        <span style={{ fontSize: 10, color: C.dim, letterSpacing: 1 }}>
          / ALERT SETTINGS
        </span>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 16px' }}>

        {loading ? (
          <div style={{ fontSize: 11, color: C.dim, textAlign: 'center', paddingTop: 40 }}>
            Loading preferences…
          </div>
        ) : (
          <>
            {/* Email toggle */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>EMAIL ALERTS</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: C.text }}>Enable email alerts</div>
                  <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>
                    Get notified when high-edge contracts are found
                  </div>
                </div>
                <button
                  onClick={() => setPrefs(p => ({ ...p, email_alerts: !p.email_alerts }))}
                  style={{
                    width: 42, height: 24, borderRadius: 12, border: 'none',
                    cursor: 'pointer', position: 'relative', flexShrink: 0,
                    background: prefs.email_alerts ? '#00ff88' : '#1a2e3e',
                    transition: 'background 0.2s',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 4, width: 16, height: 16,
                    borderRadius: '50%', background: '#fff',
                    transition: 'left 0.2s',
                    left: prefs.email_alerts ? '22px' : '4px',
                  }} />
                </button>
              </div>
              <div style={{ opacity: prefs.email_alerts ? 1 : 0.4, pointerEvents: prefs.email_alerts ? 'auto' : 'none' }}>
                <div style={{ fontSize: 9, color: C.dim, letterSpacing: 1.5, marginBottom: 5 }}>SEND ALERTS TO</div>
                <input
                  type="email"
                  value={prefs.alert_email}
                  onChange={e => setPrefs(p => ({ ...p, alert_email: e.target.value }))}
                  placeholder="you@example.com"
                  style={iSt}
                />
                <div style={{ fontSize: 9, color: '#2a5060', marginTop: 6 }}>
                  Emails sent weekdays at 9:00 am ET during market hours.
                </div>
              </div>
            </div>

            {/* Symbols */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>SYMBOLS TO WATCH</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {SYMBOLS.map(sym => {
                  const active = prefs.symbols.includes(sym)
                  return (
                    <button
                      key={sym}
                      onClick={() => toggleSymbol(sym)}
                      style={{
                        padding: '6px 14px', borderRadius: 4,
                        fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        border: `1px solid ${active ? C.green : C.border}`,
                        color:      active ? C.green : C.dim,
                        background: active ? `${C.green}18` : 'transparent',
                        fontFamily: 'inherit',
                      }}
                    >
                      {sym}
                    </button>
                  )
                })}
              </div>
              <div style={{ fontSize: 9, color: '#2a5060', marginTop: 8 }}>
                Tap to toggle. Scanner runs on all selected symbols.
              </div>
            </div>

            {/* Edge score */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>MINIMUM EDGE SCORE</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                <span style={{ fontSize: 11, color: C.dim }}>Threshold</span>
                <input
                  type="range" min={30} max={80} step={5}
                  value={prefs.min_edge_score}
                  onChange={e => setPrefs(p => ({ ...p, min_edge_score: parseInt(e.target.value) }))}
                  style={{ flex: 1, accentColor: C.green }}
                />
                <span style={{
                  fontFamily: "'Bebas Neue', sans-serif",
                  fontSize: 20, color: C.text, minWidth: 32, textAlign: 'right',
                }}>
                  {prefs.min_edge_score}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#2a5060' }}>
                <span>30 — more alerts</span>
                <span>80 — fewer, higher quality</span>
              </div>
            </div>

            {/* Schedule */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>SCHEDULE</div>
              <div style={{ fontSize: 10, color: '#4a7a8a', lineHeight: 1.9 }}>
                ⏰ Weekdays at 9:00 am ET —{' '}
                <code style={{ fontSize: 9, color: C.dim, background: '#06101a', padding: '1px 5px', borderRadius: 2 }}>
                  0 14 * * 1-5
                </code>
                {' '}UTC
              </div>
              <div style={{ fontSize: 9, color: '#2a5060', marginTop: 6 }}>
                Manual trigger:{' '}
                <code style={{ fontSize: 9, color: C.dim }}>POST /api/alerts/send</code>
                {' '}with{' '}
                <code style={{ fontSize: 9, color: C.dim }}>x-cron-secret</code> header.
              </div>
            </div>

            {error && (
              <div style={{
                fontSize: 11, color: C.red, background: '#1a0408',
                border: `1px solid ${C.red}30`, borderRadius: 5,
                padding: '9px 13px', marginBottom: 12,
              }}>
                {error}
              </div>
            )}

            {/* Save */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                onClick={handleSave}
                disabled={saving || prefs.symbols.length === 0}
                style={{
                  padding: '10px 22px', borderRadius: 5, fontSize: 12,
                  letterSpacing: 1.5, cursor: 'pointer',
                  fontFamily: "'Bebas Neue', sans-serif",
                  background: saving ? 'transparent' : `${C.green}22`,
                  border: `1px solid ${saving || prefs.symbols.length === 0 ? C.border : C.green}`,
                  color: saving || prefs.symbols.length === 0 ? C.dim : C.green,
                }}
              >
                {saving ? 'SAVING…' : 'SAVE PREFERENCES'}
              </button>
              {saved && (
                <span style={{ fontSize: 11, color: C.green }}>✓ Saved</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
