/**
 * src/pages/AlertSettings.jsx
 * Route: /app/settings/alerts
 * Now fully theme-aware via props.
 */
import { useState, useEffect } from 'react'
import AppNav from '../components/AppNav'

const SYMBOLS = ['SPY','QQQ','IWM','AAPL','TSLA','NVDA','AMZN','META']
const DEFAULT_PREFS = {
  email_alerts:   false,
  alert_email:    '',
  min_edge_score: 50,
  symbols:        ['SPY','QQQ'],
}

export default function AlertSettings(props) {
  const { getToken, isDark, setIsDark, C } = props

  const iSt = {
    width: '100%', background: C.inputBg,
    border: `1px solid ${C.border}`, borderRadius: 4,
    color: C.text, padding: '9px 12px', fontSize: 12,
    fontFamily: 'inherit', boxSizing: 'border-box',
    transition: 'border-color .15s',
  }

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
          symbols:        data.prefs.symbols         ?? ['SPY','QQQ'],
        })
      } catch (e) { setError(e.message) }
      finally     { setLoading(false)   }
    }
    load()
  }, [getToken])

  async function handleSave() {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/user/prefs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) { setError(e.message) }
    finally     { setSaving(false)    }
  }

  function toggleSymbol(sym) {
    setPrefs(p => ({
      ...p,
      symbols: p.symbols.includes(sym)
        ? p.symbols.filter(s => s !== sym)
        : [...p.symbols, sym],
    }))
  }

  const labelSt = {
    fontSize: 10, color: C.dim, letterSpacing: 1.2,
    marginBottom: 5, display: 'block', textTransform: 'uppercase',
  }
  const cardSt = {
    background: C.card, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '18px 20px', marginBottom: 16,
  }

  return (
    <div style={{
      background: C.bg, minHeight: '100vh',
      fontFamily: "'IBM Plex Mono', monospace",
      color: C.text, transition: 'background .25s, color .25s',
      paddingBottom: 80,
    }}>
      <style>{`
        input:focus,select:focus{outline:none;border-color:${C.green}!important}
        select option{background:${C.inputBg};color:${C.text}}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px}
      `}</style>

      <AppNav
        isDark={isDark} setIsDark={setIsDark} C={C}
        {...props}
        tab={null} setTab={() => {}}
        showTools={false} setShowTools={() => {}}
      />

      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px' }}>

        {/* Page title */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 28, letterSpacing: 3, color: C.green,
            margin: 0, lineHeight: 1,
          }}>ALERT SETTINGS</h1>
          <p style={{ fontSize: 10, color: C.dim, marginTop: 6, letterSpacing: 1 }}>
            Configure when and how to receive options edge alerts
          </p>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: C.dim, fontSize: 12, letterSpacing: 2 }}>
            LOADING…
          </div>
        )}

        {!loading && (
          <>
            {/* Email alerts toggle */}
            <div style={cardSt}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 13, color: C.text, marginBottom: 3, fontWeight: 600 }}>
                    Email Alerts
                  </div>
                  <div style={{ fontSize: 10, color: C.dim }}>
                    Receive high-conviction setups by email
                  </div>
                </div>
                {/* Toggle switch */}
                <div
                  onClick={() => setPrefs(p => ({ ...p, email_alerts: !p.email_alerts }))}
                  style={{
                    width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                    background: prefs.email_alerts ? C.green : C.border,
                    position: 'relative', transition: 'background .2s', flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3,
                    left: prefs.email_alerts ? 23 : 3,
                    width: 18, height: 18, borderRadius: '50%',
                    background: prefs.email_alerts ? '#000' : C.bgAlt,
                    transition: 'left .2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                  }}/>
                </div>
              </div>
            </div>

            {/* Email address */}
            {prefs.email_alerts && (
              <div style={cardSt}>
                <label style={labelSt}>Alert Email Address</label>
                <input
                  style={iSt}
                  type="email"
                  placeholder="you@example.com"
                  value={prefs.alert_email}
                  onChange={e => setPrefs(p => ({ ...p, alert_email: e.target.value }))}
                />
              </div>
            )}

            {/* Min edge score */}
            <div style={cardSt}>
              <label style={labelSt}>
                Minimum Edge Score — <span style={{ color: C.green }}>{prefs.min_edge_score}%</span>
              </label>
              <input
                type="range" min={40} max={95} step={5}
                value={prefs.min_edge_score}
                onChange={e => setPrefs(p => ({ ...p, min_edge_score: Number(e.target.value) }))}
                style={{ width: '100%', accentColor: C.green }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.dim, marginTop: 4 }}>
                <span>40% — more alerts</span>
                <span>95% — fewer, higher quality</span>
              </div>
              {/* Score band guidance */}
              <div style={{
                marginTop: 12, display: 'grid',
                gridTemplateColumns: 'repeat(3,1fr)', gap: 6,
              }}>
                {[
                  { range: '40–64%', label: 'Speculative', color: C.red },
                  { range: '65–79%', label: 'Moderate',    color: C.orange },
                  { range: '80%+',   label: 'High Conv.',  color: C.green },
                ].map(b => (
                  <div key={b.range} style={{
                    background: C.cardAlt, borderRadius: 4, padding: '8px 10px',
                    border: `1px solid ${prefs.min_edge_score >= parseInt(b.range) ? b.color + '50' : C.border}`,
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 11, color: b.color, fontWeight: 600 }}>{b.range}</div>
                    <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>{b.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Symbols watchlist */}
            <div style={cardSt}>
              <label style={labelSt}>Watch Symbols ({prefs.symbols.length} selected)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {SYMBOLS.map(sym => {
                  const active = prefs.symbols.includes(sym)
                  return (
                    <button
                      key={sym}
                      onClick={() => toggleSymbol(sym)}
                      style={{
                        padding: '7px 14px', borderRadius: 4, cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: 11, letterSpacing: .8,
                        background: active ? `${C.green}18` : C.cardAlt,
                        border: `1px solid ${active ? C.green : C.border}`,
                        color: active ? C.green : C.dim,
                        transition: 'all .15s',
                      }}
                    >{sym}</button>
                  )
                })}
              </div>
              <div style={{ fontSize: 9, color: C.dim, marginTop: 10 }}>
                Alerts only fire for these symbols. Deselect all to watch everything.
              </div>
            </div>

            {/* Error */}
            {error && (
              <div style={{
                background: `${C.red}15`, border: `1px solid ${C.red}40`,
                borderRadius: 6, padding: '12px 16px', color: C.red,
                fontSize: 12, marginBottom: 16,
              }}>⚠ {error}</div>
            )}

            {/* Save button */}
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                width: '100%', padding: '14px',
                fontFamily: "'Bebas Neue', sans-serif",
                fontSize: 16, letterSpacing: 2,
                background: saved ? `${C.green}30` : `${C.green}20`,
                border: `1px solid ${saved ? C.green : C.green + '80'}`,
                color: C.green, borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.6 : 1, transition: 'all .2s',
              }}
            >
              {saving ? 'SAVING…' : saved ? '✓ SAVED' : 'SAVE PREFERENCES'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
