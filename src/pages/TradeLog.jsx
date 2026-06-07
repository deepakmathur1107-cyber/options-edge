/**
 * src/pages/TradeLog.jsx
 *
 * Trade journal — log, track, and close options trades.
 * Route: /app/trades
 */
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

const C = {
  green:  '#00ff88',
  blue:   '#00c8ff',
  orange: '#ff9500',
  red:    '#ff4466',
  dim:    '#4a7a8a',
  card:   '#0d1a26',
  bg:     '#090e14',
  border: '#1a2e3e',
  text:   '#c8d8e8',
}

const iSt = {
  width: '100%',
  background: '#0d1a26',
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  color: C.text,
  padding: '9px 12px',
  fontSize: 12,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

const EMPTY_FORM = {
  symbol:      '',
  option_type: 'call',
  strike:      '',
  expiration:  '',
  action:      'buy',
  contracts:   '1',
  premium:     '',
  notes:       '',
}

const EMPTY_CLOSE = {
  exit_price: '',
}

function fmt(val, decimals = 2) {
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  return n.toFixed(decimals)
}

function fmtPnl(trade) {
  if (!trade.exit_price || !trade.entry_price) return null
  const contracts = trade.contracts ?? 1
  const multiplier = 100
  const entry = parseFloat(trade.entry_price)
  const exit  = parseFloat(trade.exit_price)
  if (isNaN(entry) || isNaN(exit)) return null
  const pnl = trade.action === 'buy'
    ? (exit - entry) * contracts * multiplier
    : (entry - exit) * contracts * multiplier
  return pnl
}

function PnlBadge({ trade }) {
  const pnl = fmtPnl(trade)
  if (pnl === null) return null
  const color = pnl >= 0 ? C.green : C.red
  const sign  = pnl >= 0 ? '+' : ''
  return (
    <span style={{
      color,
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
    }}>
      {sign}${Math.abs(pnl).toFixed(0)}
    </span>
  )
}

export default function TradeLog({ getToken }) {
  const [trades,      setTrades]      = useState([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [filter,      setFilter]      = useState('open')   // 'open' | 'closed' | 'all'
  const [showAdd,     setShowAdd]     = useState(false)
  const [form,        setForm]        = useState(EMPTY_FORM)
  const [submitting,  setSubmitting]  = useState(false)
  const [formError,   setFormError]   = useState(null)
  const [closingId,   setClosingId]   = useState(null)     // trade id being closed
  const [closeForm,   setCloseForm]   = useState(EMPTY_CLOSE)
  const [closeError,  setCloseError]  = useState(null)
  const [deletingId,  setDeletingId]  = useState(null)

  async function authHeaders() {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  async function loadTrades() {
    try {
      const headers = await authHeaders()
      const res = await fetch('/api/user/trades', { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTrades(data.trades ?? [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTrades() }, [getToken])

  async function handleAdd() {
    setFormError(null)
    if (!form.symbol || !form.strike || !form.expiration || !form.premium) {
      setFormError('Symbol, strike, expiration, and premium are required.')
      return
    }
    setSubmitting(true)
    try {
      const headers = await authHeaders()
      const res = await fetch('/api/user/trades', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          symbol:       form.symbol.toUpperCase().trim(),
          option_type:  form.option_type,
          strike:       parseFloat(form.strike),
          expiration:   form.expiration,
          action:       form.action,
          contracts:    parseInt(form.contracts) || 1,
          entry_price:  parseFloat(form.premium),
          notes:        form.notes.trim() || null,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setForm(EMPTY_FORM)
      setShowAdd(false)
      await loadTrades()
    } catch (e) {
      setFormError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleClose(id) {
    setCloseError(null)
    if (!closeForm.exit_price) {
      setCloseError('Exit price is required.')
      return
    }
    setSubmitting(true)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/user/trades?id=${id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          exit_price: parseFloat(closeForm.exit_price),
          status:     'closed',
          closed_at:  new Date().toISOString(),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setClosingId(null)
      setCloseForm(EMPTY_CLOSE)
      await loadTrades()
    } catch (e) {
      setCloseError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this trade?')) return
    setDeletingId(id)
    try {
      const headers = await authHeaders()
      await fetch(`/api/user/trades?id=${id}`, { method: 'DELETE', headers })
      await loadTrades()
    } catch (e) {
      setError(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  // ── Derived data ──────────────────────────────────────────────────
  const openTrades   = trades.filter(t => t.status !== 'closed')
  const closedTrades = trades.filter(t => t.status === 'closed')

  const totalPnl = closedTrades.reduce((sum, t) => {
    const p = fmtPnl(t)
    return sum + (p ?? 0)
  }, 0)

  const winCount  = closedTrades.filter(t => (fmtPnl(t) ?? 0) > 0).length
  const lossCount = closedTrades.filter(t => (fmtPnl(t) ?? 0) <= 0).length
  const winRate   = closedTrades.length > 0
    ? Math.round((winCount / closedTrades.length) * 100)
    : null

  const displayed = filter === 'open'   ? openTrades
                  : filter === 'closed' ? closedTrades
                  : trades

  // ── Styles ────────────────────────────────────────────────────────
  const labelSt = { fontSize: 10, color: C.dim, letterSpacing: 1, marginBottom: 5, display: 'block' }
  const btnSt   = (bg, col) => ({
    background: bg, color: col, border: 'none', borderRadius: 3,
    padding: '8px 16px', fontSize: 11, fontFamily: 'inherit',
    letterSpacing: 1, cursor: 'pointer', fontWeight: 600,
  })

  return (
    <div style={{
      background: C.bg, minHeight: '100vh',
      fontFamily: "'IBM Plex Mono', monospace",
      color: C.text, paddingBottom: 60,
    }}>

      {/* ── Header ── */}
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
          / TRADE LOG
        </span>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>

        {/* ── Summary cards ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12, marginBottom: 24,
        }}>
          {[
            { label: 'OPEN POSITIONS', value: openTrades.length, color: C.blue },
            { label: 'CLOSED TRADES',  value: closedTrades.length, color: C.dim },
            {
              label: 'TOTAL P&L',
              value: closedTrades.length ? `${totalPnl >= 0 ? '+' : ''}$${Math.abs(totalPnl).toFixed(0)}` : '—',
              color: totalPnl >= 0 ? C.green : C.red,
            },
            {
              label: 'WIN RATE',
              value: winRate !== null ? `${winRate}%` : '—',
              color: winRate >= 50 ? C.green : winRate !== null ? C.red : C.dim,
            },
          ].map(card => (
            <div key={card.label} style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: '14px 16px',
            }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 1.5, marginBottom: 8 }}>
                {card.label}
              </div>
              <div style={{ fontSize: 22, color: card.color, fontWeight: 700 }}>
                {card.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── Toolbar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 16, flexWrap: 'wrap', gap: 10,
        }}>
          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 4 }}>
            {['open', 'closed', 'all'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  ...btnSt(
                    filter === f ? `${C.green}18` : 'transparent',
                    filter === f ? C.green : C.dim,
                  ),
                  border: `1px solid ${filter === f ? C.green : C.border}`,
                  padding: '6px 14px',
                }}
              >
                {f.toUpperCase()}
                {f === 'open'   ? ` (${openTrades.length})`   : ''}
                {f === 'closed' ? ` (${closedTrades.length})` : ''}
              </button>
            ))}
          </div>

          {/* Add trade button */}
          <button
            onClick={() => { setShowAdd(v => !v); setFormError(null) }}
            style={{
              ...btnSt(`${C.green}20`, C.green),
              border: `1px solid ${C.green}`,
              padding: '6px 16px',
            }}
          >
            {showAdd ? '✕ CANCEL' : '+ LOG TRADE'}
          </button>
        </div>

        {/* ── Add trade form ── */}
        {showAdd && (
          <div style={{
            background: C.card, border: `1px solid ${C.green}30`,
            borderRadius: 6, padding: '20px 20px 16px', marginBottom: 20,
          }}>
            <div style={{ fontSize: 11, color: C.green, letterSpacing: 2, marginBottom: 16 }}>
              NEW TRADE
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
              {/* Symbol */}
              <div>
                <label style={labelSt}>SYMBOL</label>
                <input
                  style={iSt}
                  placeholder="SPY"
                  value={form.symbol}
                  onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
                />
              </div>

              {/* Type */}
              <div>
                <label style={labelSt}>TYPE</label>
                <select
                  style={iSt}
                  value={form.option_type}
                  onChange={e => setForm(f => ({ ...f, option_type: e.target.value }))}
                >
                  <option value="call">CALL</option>
                  <option value="put">PUT</option>
                </select>
              </div>

              {/* Action */}
              <div>
                <label style={labelSt}>ACTION</label>
                <select
                  style={iSt}
                  value={form.action}
                  onChange={e => setForm(f => ({ ...f, action: e.target.value }))}
                >
                  <option value="buy">BUY</option>
                  <option value="sell">SELL</option>
                </select>
              </div>

              {/* Strike */}
              <div>
                <label style={labelSt}>STRIKE</label>
                <input
                  style={iSt}
                  placeholder="500"
                  type="number"
                  value={form.strike}
                  onChange={e => setForm(f => ({ ...f, strike: e.target.value }))}
                />
              </div>

              {/* Expiration */}
              <div>
                <label style={labelSt}>EXPIRATION</label>
                <input
                  style={iSt}
                  type="date"
                  value={form.expiration}
                  onChange={e => setForm(f => ({ ...f, expiration: e.target.value }))}
                />
              </div>

              {/* Contracts */}
              <div>
                <label style={labelSt}>CONTRACTS</label>
                <input
                  style={iSt}
                  placeholder="1"
                  type="number"
                  min="1"
                  value={form.contracts}
                  onChange={e => setForm(f => ({ ...f, contracts: e.target.value }))}
                />
              </div>

              {/* Premium */}
              <div>
                <label style={labelSt}>PREMIUM / CONTRACT</label>
                <input
                  style={iSt}
                  placeholder="2.50"
                  type="number"
                  step="0.01"
                  value={form.premium}
                  onChange={e => setForm(f => ({ ...f, premium: e.target.value }))}
                />
              </div>
            </div>

            {/* Notes */}
            <div style={{ marginTop: 12 }}>
              <label style={labelSt}>NOTES (OPTIONAL)</label>
              <input
                style={iSt}
                placeholder="e.g. high edge score, earnings play…"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>

            {formError && (
              <div style={{ color: C.red, fontSize: 11, marginTop: 10 }}>{formError}</div>
            )}

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button
                onClick={handleAdd}
                disabled={submitting}
                style={{ ...btnSt(C.green, '#000'), opacity: submitting ? 0.6 : 1 }}
              >
                {submitting ? 'SAVING…' : 'SAVE TRADE'}
              </button>
            </div>
          </div>
        )}

        {/* ── Error state ── */}
        {error && (
          <div style={{
            background: `${C.red}15`, border: `1px solid ${C.red}40`,
            borderRadius: 6, padding: '12px 16px',
            color: C.red, fontSize: 12, marginBottom: 16,
          }}>
            Error: {error}
          </div>
        )}

        {/* ── Loading ── */}
        {loading && (
          <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', padding: 40 }}>
            LOADING…
          </div>
        )}

        {/* ── Empty state ── */}
        {!loading && displayed.length === 0 && (
          <div style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '40px 20px',
            textAlign: 'center', color: C.dim, fontSize: 12,
          }}>
            {filter === 'open'
              ? 'No open positions. Click + LOG TRADE to add one.'
              : filter === 'closed'
              ? 'No closed trades yet.'
              : 'No trades logged yet.'}
          </div>
        )}

        {/* ── Trade table ── */}
        {!loading && displayed.length > 0 && (
          <div style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 6, overflow: 'hidden',
          }}>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '80px 50px 50px 70px 90px 50px 70px 70px 1fr 90px',
              gap: 0,
              borderBottom: `1px solid ${C.border}`,
              padding: '8px 16px',
              fontSize: 9, color: C.dim, letterSpacing: 1.2,
            }}>
              <span>SYMBOL</span>
              <span>TYPE</span>
              <span>SIDE</span>
              <span>STRIKE</span>
              <span>EXP</span>
              <span>QTY</span>
              <span>ENTRY</span>
              <span>EXIT</span>
              <span>P&L</span>
              <span style={{ textAlign: 'right' }}>ACTIONS</span>
            </div>

            {/* Rows */}
            {displayed.map((trade, i) => {
              const isClosed  = trade.status === 'closed'
              const isClosing = closingId === trade.id
              const pnl       = fmtPnl(trade)
              const rowBg     = i % 2 === 0 ? 'transparent' : '#0b1520'

              return (
                <div key={trade.id}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '80px 50px 50px 70px 90px 50px 70px 70px 1fr 90px',
                    gap: 0,
                    padding: '10px 16px',
                    background: rowBg,
                    borderBottom: `1px solid ${C.border}20`,
                    alignItems: 'center',
                    fontSize: 11,
                    opacity: isClosed ? 0.6 : 1,
                  }}>
                    <span style={{ color: C.blue, fontWeight: 700 }}>{trade.symbol}</span>
                    <span style={{
                      color: trade.option_type === 'call' ? C.green : C.orange,
                      textTransform: 'uppercase', fontSize: 10,
                    }}>
                      {trade.option_type}
                    </span>
                    <span style={{
                      color: trade.action === 'buy' ? C.green : C.red,
                      textTransform: 'uppercase', fontSize: 10,
                    }}>
                      {trade.action}
                    </span>
                    <span>${fmt(trade.strike, 0)}</span>
                    <span style={{ color: C.dim }}>{trade.expiration}</span>
                    <span>{trade.contracts ?? 1}</span>
                    <span>${fmt(trade.entry_price)}</span>
                    <span style={{ color: isClosed ? C.text : C.dim }}>
                      {isClosed ? `$${fmt(trade.exit_price)}` : '—'}
                    </span>
                    <span><PnlBadge trade={trade} /></span>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {!isClosed && (
                        <button
                          onClick={() => {
                            setClosingId(isClosing ? null : trade.id)
                            setCloseForm(EMPTY_CLOSE)
                            setCloseError(null)
                          }}
                          style={{
                            ...btnSt(`${C.orange}20`, C.orange),
                            border: `1px solid ${C.orange}60`,
                            padding: '4px 10px', fontSize: 10,
                          }}
                        >
                          {isClosing ? 'CANCEL' : 'CLOSE'}
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(trade.id)}
                        disabled={deletingId === trade.id}
                        style={{
                          ...btnSt(`${C.red}15`, C.red),
                          border: `1px solid ${C.red}40`,
                          padding: '4px 8px', fontSize: 10,
                          opacity: deletingId === trade.id ? 0.5 : 1,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* ── Inline close form ── */}
                  {isClosing && (
                    <div style={{
                      background: `${C.orange}08`,
                      borderBottom: `1px solid ${C.orange}30`,
                      padding: '12px 16px',
                      display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
                    }}>
                      <div>
                        <label style={{ ...labelSt, color: C.orange }}>EXIT PRICE / CONTRACT</label>
                        <input
                          style={{ ...iSt, width: 140, border: `1px solid ${C.orange}50` }}
                          placeholder="e.g. 4.20"
                          type="number"
                          step="0.01"
                          value={closeForm.exit_price}
                          onChange={e => setCloseForm({ exit_price: e.target.value })}
                          autoFocus
                        />
                      </div>
                      {closeForm.exit_price && (
                        <div style={{ fontSize: 11, color: C.dim, paddingBottom: 10 }}>
                          Est. P&L:{' '}
                          <PnlBadge trade={{ ...trade, exit_price: parseFloat(closeForm.exit_price) }} />
                        </div>
                      )}
                      {closeError && (
                        <div style={{ color: C.red, fontSize: 11 }}>{closeError}</div>
                      )}
                      <button
                        onClick={() => handleClose(trade.id)}
                        disabled={submitting}
                        style={{
                          ...btnSt(C.orange, '#000'),
                          opacity: submitting ? 0.6 : 1,
                          marginBottom: 1,
                        }}
                      >
                        {submitting ? 'SAVING…' : 'CONFIRM CLOSE'}
                      </button>
                    </div>
                  )}

                  {/* Notes row */}
                  {trade.notes && (
                    <div style={{
                      background: rowBg,
                      borderBottom: `1px solid ${C.border}20`,
                      padding: '4px 16px 8px 16px',
                      fontSize: 10, color: C.dim, fontStyle: 'italic',
                    }}>
                      ↳ {trade.notes}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── Win/loss breakdown (only when there are closed trades) ── */}
        {closedTrades.length > 0 && (
          <div style={{
            marginTop: 16,
            display: 'flex', gap: 12, flexWrap: 'wrap',
          }}>
            {[
              { label: 'WINS',   value: winCount,  color: C.green },
              { label: 'LOSSES', value: lossCount, color: C.red   },
              { label: 'WIN RATE', value: winRate !== null ? `${winRate}%` : '—', color: winRate >= 50 ? C.green : C.red },
            ].map(s => (
              <div key={s.label} style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 4, padding: '8px 16px',
                fontSize: 11, display: 'flex', gap: 8, alignItems: 'center',
              }}>
                <span style={{ color: C.dim, fontSize: 9, letterSpacing: 1 }}>{s.label}</span>
                <span style={{ color: s.color, fontWeight: 700 }}>{s.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
