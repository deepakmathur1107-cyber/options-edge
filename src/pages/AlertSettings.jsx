/**
 * src/pages/AlertSettings.jsx
 *
 * Alert & notification preferences.
 * Route: /app/settings/alerts
 *
 * Features:
 *  - Email alerts toggle + address field
 *  - SMS alerts toggle + phone number field (Twilio)
 *  - Min edge score slider (40–95%)
 *  - Watch symbols: preset chips + custom ticker input
 *  - Pro plan: max 5 symbols | Admin: unlimited
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

// ── Default preset symbols ────────────────────────────────────────────────
const PRESET_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'META']

const DEFAULT_PREFS = {
  email_alerts:   false,
  alert_email:    '',
  min_edge_score: 50,
  symbols:        ['SPY', 'QQQ'],
  sms_alerts:     false,
  phone_number:   '',
}

// ── Styles ────────────────────────────────────────────────────────────────
const S = {
  page: {
    minHeight: '100vh',
    background: '#090e14',
    color: '#c8d8e8',
    fontFamily: 'Inter, sans-serif',
    padding: '0 0 80px',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '14px 24px',
    borderBottom: '1px solid #1a2e3e',
    background: '#090e14',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 14px',
    border: '1px solid #1a2e3e',
    borderRadius: 4,
    background: 'transparent',
    color: '#c8d8e8',
    fontSize: 12,
    fontFamily: 'Inter, sans-serif',
    cursor: 'pointer',
    textDecoration: 'none',
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: '#c8d8e8',
  },
  content: {
    maxWidth: 640,
    margin: '0 auto',
    padding: '32px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },
  heading: {
    fontSize: 28,
    fontFamily: 'Bebas Neue, sans-serif',
    letterSpacing: 2,
    color: '#00ff88',
    marginBottom: 4,
  },
  subheading: {
    fontSize: 12,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
  },
  card: {
    background: '#0d1a26',
    border: '1px solid #1a2e3e',
    borderRadius: 8,
    padding: 20,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: '#c8d8e8',
    marginBottom: 14,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    color: '#c8d8e8',
    fontWeight: 600,
  },
  sublabel: {
    fontSize: 11,
    color: '#4a7a8a',
    marginTop: 2,
  },
  toggle: (on) => ({
    width: 44,
    height: 24,
    borderRadius: 12,
    background: on ? '#00ff88' : '#1a2e3e',
    position: 'relative',
    cursor: 'pointer',
    border: 'none',
    flexShrink: 0,
    transition: 'background 0.2s',
  }),
  toggleThumb: (on) => ({
    position: 'absolute',
    top: 3,
    left: on ? 23 : 3,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: on ? '#090e14' : '#4a7a8a',
    transition: 'left 0.2s',
  }),
  input: {
    width: '100%',
    background: '#090e14',
    border: '1px solid #1a2e3e',
    borderRadius: 4,
    color: '#c8d8e8',
    padding: '9px 12px',
    fontSize: 13,
    fontFamily: 'Inter, sans-serif',
    boxSizing: 'border-box',
    outline: 'none',
  },
  inputFocused: {
    border: '1px solid #00ff88',
  },
  slider: {
    width: '100%',
    accentColor: '#00ff88',
    cursor: 'pointer',
  },
  sliderLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 10,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
    marginTop: 6,
  },
  tiers: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginTop: 12,
  },
  tierChip: (active, color) => ({
    padding: '8px 4px',
    borderRadius: 4,
    border: `1px solid ${active ? color : '#1a2e3e'}`,
    background: active ? `${color}18` : 'transparent',
    textAlign: 'center',
    cursor: 'pointer',
  }),
  tierLabel: (color) => ({
    fontSize: 13,
    fontWeight: 700,
    color,
    fontFamily: 'IBM Plex Mono, monospace',
  }),
  tierSub: {
    fontSize: 10,
    color: '#4a7a8a',
    marginTop: 2,
  },
  symbolsWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  symChip: (active) => ({
    padding: '6px 14px',
    borderRadius: 4,
    border: `1px solid ${active ? '#00ff88' : '#1a2e3e'}`,
    background: active ? '#00ff8818' : 'transparent',
    color: active ? '#00ff88' : '#4a7a8a',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'IBM Plex Mono, monospace',
    cursor: 'pointer',
    letterSpacing: 1,
  }),
  customSymChip: (active) => ({
    padding: '6px 10px',
    borderRadius: 4,
    border: `1px solid ${active ? '#00c8ff' : '#1a2e3e'}`,
    background: active ? '#00c8ff18' : 'transparent',
    color: active ? '#00c8ff' : '#4a7a8a',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'IBM Plex Mono, monospace',
    cursor: 'pointer',
    letterSpacing: 1,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  }),
  addRow: {
    display: 'flex',
    gap: 8,
    marginTop: 4,
  },
  addBtn: {
    padding: '9px 16px',
    background: '#00ff8820',
    border: '1px solid #00ff88',
    borderRadius: 4,
    color: '#00ff88',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'IBM Plex Mono, monospace',
    cursor: 'pointer',
    letterSpacing: 1,
    flexShrink: 0,
  },
  limitNote: {
    fontSize: 11,
    color: '#ff9500',
    fontFamily: 'IBM Plex Mono, monospace',
    marginTop: 8,
  },
  saveBtn: {
    width: '100%',
    padding: '14px',
    background: '#00ff88',
    border: 'none',
    borderRadius: 6,
    color: '#090e14',
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 2,
    textTransform: 'uppercase',
    cursor: 'pointer',
    fontFamily: 'Inter, sans-serif',
  },
  saveBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  errorBox: {
    background: '#ff446618',
    border: '1px solid #ff4466',
    borderRadius: 6,
    padding: '12px 16px',
    color: '#ff6688',
    fontSize: 12,
    fontFamily: 'IBM Plex Mono, monospace',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  successBox: {
    background: '#00ff8818',
    border: '1px solid #00ff88',
    borderRadius: 6,
    padding: '12px 16px',
    color: '#00ff88',
    fontSize: 12,
    fontFamily: 'IBM Plex Mono, monospace',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  smsNote: {
    fontSize: 11,
    color: '#4a7a8a',
    fontFamily: 'IBM Plex Mono, monospace',
    marginTop: 8,
    lineHeight: 1.5,
  },
  planBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 10px',
    borderRadius: 20,
    background: '#00ff8818',
    border: '1px solid #00ff88',
    color: '#00ff88',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'IBM Plex Mono, monospace',
    letterSpacing: 1,
  },
}

// ── Toggle button ─────────────────────────────────────────────────────────
function Toggle({ on, onChange }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={S.toggle(on)}
      aria-checked={on}
      role="switch"
    >
      <span style={S.toggleThumb(on)} />
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────
export default function AlertSettings({ getToken, isAdmin = false }) {
  const [prefs,      setPrefs]      = useState(DEFAULT_PREFS)
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [status,     setStatus]     = useState(null)   // null | 'saved' | 'error'
  const [errorMsg,   setErrorMsg]   = useState('')
  const [customInput, setCustomInput] = useState('')
  const [customSyms, setCustomSyms] = useState([])     // symbols NOT in PRESET_SYMBOLS
  const [focusEmail, setFocusEmail] = useState(false)
  const [focusPhone, setFocusPhone] = useState(false)
  const [focusCustom, setFocusCustom] = useState(false)

  // Pro plan: 5 symbol limit. Admin: unlimited.
  const MAX_SYMBOLS = isAdmin ? 999 : 5
  const selectedCount = prefs.symbols.length

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch('/api/user/prefs', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }
        const { prefs: p } = await res.json()
        const loaded = {
          email_alerts:   p.email_alerts   ?? false,
          alert_email:    p.alert_email    ?? '',
          min_edge_score: p.min_edge_score ?? 50,
          symbols:        p.symbols        ?? ['SPY', 'QQQ'],
          sms_alerts:     p.sms_alerts     ?? false,
          phone_number:   p.phone_number   ?? '',
        }
        setPrefs(loaded)
        // Separate custom (non-preset) symbols
        setCustomSyms(loaded.symbols.filter(s => !PRESET_SYMBOLS.includes(s)))
      } catch (e) {
        setErrorMsg(e.message)
        setStatus('error')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [getToken])

  // ── Symbol toggle ───────────────────────────────────────────────────────
  function toggleSymbol(sym) {
    setPrefs(p => {
      const has = p.symbols.includes(sym)
      if (!has && p.symbols.length >= MAX_SYMBOLS) return p  // limit reached
      return {
        ...p,
        symbols: has ? p.symbols.filter(s => s !== sym) : [...p.symbols, sym],
      }
    })
  }

  // ── Add custom symbol ───────────────────────────────────────────────────
  function addCustomSymbol() {
    const sym = customInput.toUpperCase().trim().replace(/[^A-Z]/g, '')
    if (!sym || sym.length > 5) return
    if (prefs.symbols.includes(sym)) { setCustomInput(''); return }
    if (prefs.symbols.length >= MAX_SYMBOLS) return
    setCustomSyms(c => [...c, sym])
    setPrefs(p => ({ ...p, symbols: [...p.symbols, sym] }))
    setCustomInput('')
  }

  function removeCustomSymbol(sym) {
    setCustomSyms(c => c.filter(s => s !== sym))
    setPrefs(p => ({ ...p, symbols: p.symbols.filter(s => s !== sym) }))
  }

  // ── Edge score tier label ───────────────────────────────────────────────
  const score = prefs.min_edge_score
  const tier = score < 65 ? 'speculative' : score < 80 ? 'moderate' : 'high'

  // ── Save ────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    setStatus(null)
    setErrorMsg('')
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
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setStatus('saved')
      setTimeout(() => setStatus(null), 3000)
    } catch (e) {
      setErrorMsg(e.message)
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#4a7a8a', fontFamily: 'IBM Plex Mono, monospace', fontSize: 12 }}>
          Loading preferences…
        </span>
      </div>
    )
  }

  return (
    <div style={S.page}>
      {/* Top bar */}
      <div style={S.topBar}>
        <Link to="/app" style={S.backBtn}>← BACK</Link>
        <span style={S.title}>Alert Settings</span>
      </div>

      <div style={S.content}>
        {/* Header */}
        <div>
          <div style={S.heading}>ALERT SETTINGS</div>
          <div style={S.subheading}>Configure when and how to receive options edge alerts</div>
          {isAdmin && <span style={{ ...S.planBadge, marginTop: 8, display: 'inline-flex' }}>⚡ ADMIN — UNLIMITED</span>}
          {!isAdmin && (
            <span style={{ ...S.planBadge, marginTop: 8, display: 'inline-flex', borderColor: '#ff9500', color: '#ff9500', background: '#ff950018' }}>
              PRO — 5 SYMBOLS MAX
            </span>
          )}
        </div>

        {/* ── Email Alerts ── */}
        <div style={S.card}>
          <div style={S.row}>
            <div>
              <div style={S.label}>Email Alerts</div>
              <div style={S.sublabel}>Receive high-conviction setups by email</div>
            </div>
            <Toggle on={prefs.email_alerts} onChange={v => setPrefs(p => ({ ...p, email_alerts: v }))} />
          </div>
          {prefs.email_alerts && (
            <input
              type="email"
              placeholder="alerts@youremail.com"
              value={prefs.alert_email}
              onChange={e => setPrefs(p => ({ ...p, alert_email: e.target.value }))}
              onFocus={() => setFocusEmail(true)}
              onBlur={() => setFocusEmail(false)}
              style={{ ...S.input, ...(focusEmail ? S.inputFocused : {}) }}
            />
          )}
        </div>

        {/* ── SMS Alerts ── */}
        <div style={S.card}>
          <div style={S.row}>
            <div>
              <div style={S.label}>SMS Alerts</div>
              <div style={S.sublabel}>Get a text when a high-conviction play fires</div>
            </div>
            <Toggle on={prefs.sms_alerts} onChange={v => setPrefs(p => ({ ...p, sms_alerts: v }))} />
          </div>
          {prefs.sms_alerts && (
            <>
              <input
                type="tel"
                placeholder="+1 312 555 0100"
                value={prefs.phone_number}
                onChange={e => setPrefs(p => ({ ...p, phone_number: e.target.value }))}
                onFocus={() => setFocusPhone(true)}
                onBlur={() => setFocusPhone(false)}
                style={{ ...S.input, ...(focusPhone ? S.inputFocused : {}) }}
              />
              <div style={S.smsNote}>
                Include country code (e.g. +1 for US). Standard SMS rates may apply.
                Texts sent at 9 AM ET on trading days when qualifying alerts are found.
              </div>
            </>
          )}
        </div>

        {/* ── Min Edge Score ── */}
        <div style={S.card}>
          <div style={S.cardTitle}>
            Minimum Edge Score — <span style={{ color: '#00ff88', fontFamily: 'IBM Plex Mono, monospace' }}>{score}%</span>
          </div>
          <input
            type="range"
            min={40}
            max={95}
            step={5}
            value={score}
            onChange={e => setPrefs(p => ({ ...p, min_edge_score: Number(e.target.value) }))}
            style={S.slider}
          />
          <div style={S.sliderLabels}>
            <span>40% — more alerts</span>
            <span>95% — fewer, higher quality</span>
          </div>
          <div style={S.tiers}>
            {[
              { label: '40–64%', sub: 'Speculative', color: '#ff9500', active: tier === 'speculative' },
              { label: '65–79%', sub: 'Moderate',    color: '#00c8ff', active: tier === 'moderate'    },
              { label: '80%+',   sub: 'High Conv.',  color: '#00ff88', active: tier === 'high'        },
            ].map(t => (
              <div key={t.label} style={S.tierChip(t.active, t.color)}>
                <div style={S.tierLabel(t.color)}>{t.label}</div>
                <div style={S.tierSub}>{t.sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Watch Symbols ── */}
        <div style={S.card}>
          <div style={S.cardTitle}>
            Watch Symbols ({selectedCount} selected
            {!isAdmin && ` / ${MAX_SYMBOLS} max`})
          </div>

          {/* Preset chips */}
          <div style={S.symbolsWrap}>
            {PRESET_SYMBOLS.map(sym => (
              <button
                key={sym}
                onClick={() => toggleSymbol(sym)}
                style={S.symChip(prefs.symbols.includes(sym))}
                disabled={!prefs.symbols.includes(sym) && selectedCount >= MAX_SYMBOLS}
              >
                {sym}
              </button>
            ))}
          </div>

          {/* Custom symbol chips */}
          {customSyms.length > 0 && (
            <div style={{ ...S.symbolsWrap, marginBottom: 12 }}>
              {customSyms.map(sym => (
                <span key={sym} style={S.customSymChip(true)}>
                  {sym}
                  <span
                    onClick={() => removeCustomSymbol(sym)}
                    style={{ cursor: 'pointer', color: '#ff4466', fontWeight: 900, fontSize: 14 }}
                  >×</span>
                </span>
              ))}
            </div>
          )}

          {/* Add custom ticker */}
          {selectedCount < MAX_SYMBOLS ? (
            <div style={S.addRow}>
              <input
                type="text"
                placeholder="Add ticker (e.g. GOOG)"
                value={customInput}
                onChange={e => setCustomInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))}
                onKeyDown={e => e.key === 'Enter' && addCustomSymbol()}
                onFocus={() => setFocusCustom(true)}
                onBlur={() => setFocusCustom(false)}
                style={{ ...S.input, ...(focusCustom ? S.inputFocused : {}) }}
                maxLength={5}
              />
              <button onClick={addCustomSymbol} style={S.addBtn}>+ ADD</button>
            </div>
          ) : (
            !isAdmin && (
              <div style={S.limitNote}>
                ⚠ Pro plan limit reached (5 symbols). Upgrade to Elite for unlimited watchlist.
              </div>
            )
          )}

          <div style={{ ...S.sublabel, marginTop: 10 }}>
            Alerts only fire for these symbols. Deselect all to watch everything.
          </div>
        </div>

        {/* ── Status messages ── */}
        {status === 'error' && (
          <div style={S.errorBox}>
            <span>⚠</span>
            <span>{errorMsg || 'Failed to save. Check console for details.'}</span>
          </div>
        )}
        {status === 'saved' && (
          <div style={S.successBox}>
            <span>✓</span>
            <span>Preferences saved successfully.</span>
          </div>
        )}

        {/* ── Save button ── */}
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ ...S.saveBtn, ...(saving ? S.saveBtnDisabled : {}) }}
        >
          {saving ? 'SAVING…' : 'SAVE PREFERENCES'}
        </button>
      </div>
    </div>
  )
}
