/**
 * src/pages/TradeLog.jsx
 * Route: /app/trades
 *
 * Unified trade journal + backtest analytics.
 * Fully theme-aware — receives isDark, C from Router via authProps.
 */
import { useState, useEffect } from 'react'
import AppNav from '../components/AppNav'

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (v, d = 2) => { const n = parseFloat(v); return isNaN(n) ? '—' : n.toFixed(d) }
const fmtDollar = (v) => { const n = parseFloat(v); return isNaN(n) ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0) }

function calcPnl(trade) {
  const entry = parseFloat(trade.entry_price ?? trade.entry ?? 0)
  const exit  = parseFloat(trade.exit_price  ?? trade.exitPrice ?? 0)
  const qty   = parseInt(trade.contracts ?? 1)
  const side  = (trade.action ?? trade.side ?? 'buy').toLowerCase()
  if (!exit || !entry) return null
  const raw = side === 'sell'
    ? (entry - exit) * qty * 100
    : (exit  - entry) * qty * 100
  return raw
}

const EMPTY_FORM = {
  symbol: '', option_type: 'call', action: 'buy',
  strike: '', expiration: '', contracts: '1', premium: '', notes: '',
}
const EMPTY_CLOSE = { exit_price: '' }

// ── Sub-components ────────────────────────────────────────────────────────────
function StatCard({ label, value, color, C }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: '14px 16px',
      transition: 'background .25s',
    }}>
      <div style={{ fontSize: 9, color: C.dim, letterSpacing: 1.5, marginBottom: 8, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, color: color ?? C.text, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{value}</div>
    </div>
  )
}

function PnlBadge({ trade, C }) {
  const p = calcPnl(trade)
  if (p === null) return null
  const color = p >= 0 ? C.green : C.red
  return <span style={{ color, fontSize: 11, fontWeight: 700 }}>{p >= 0 ? '+' : '-'}${Math.abs(p).toFixed(0)}</span>
}

function FilterTab({ label, active, count, onClick, C }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: .8,
      border: `1px solid ${active ? C.green : C.border}`,
      background: active ? `${C.green}18` : 'transparent',
      color: active ? C.green : C.dim,
      transition: 'all .15s',
    }}>
      {label}{count !== undefined ? ` (${count})` : ''}
    </button>
  )
}

// ── Equity curve sparkline ────────────────────────────────────────────────────
function EquityCurve({ trades, C }) {
  const closed = trades
    .filter(t => (t.status ?? '').toLowerCase() === 'closed' || t.exit_price)
    .slice()
    .reverse()
  if (closed.length < 2) return (
    <div style={{
      textAlign: 'center', padding: '24px 0', fontSize: 11, color: C.dim,
      border: `1px dashed ${C.border}`, borderRadius: 6,
    }}>Log 2+ closed trades to see equity curve</div>
  )
  const W = 400, H = 80
  const cumPnl = closed.reduce((acc, t) => {
    const prev = acc[acc.length - 1]?.y ?? 0
    const p = calcPnl(t) ?? parseFloat(t.pnl ?? 0)
    acc.push({ y: prev + p })
    return acc
  }, [])
  const vals = cumPnl.map(p => p.y)
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals)
  const range = maxV - minV || 1
  const toY = v => H - ((v - minV) / range) * H * 0.85 - H * 0.05
  const pts = cumPnl.map((p, i) => `${(i / (cumPnl.length - 1)) * W},${toY(p.y)}`).join(' ')
  const lastY = cumPnl[cumPnl.length - 1].y
  const lc = lastY >= 0 ? C.green : C.red
  const zeroY = toY(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
      <defs>
        <linearGradient id="ecg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={lc} stopOpacity=".25"/>
          <stop offset="100%" stopColor={lc} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={C.border} strokeWidth={1} strokeDasharray="4,4"/>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#ecg)"/>
      <polyline points={pts} fill="none" stroke={lc} strokeWidth={2}/>
      <circle cx={(cumPnl.length-1)/(cumPnl.length-1)*W} cy={toY(lastY)} r={3.5} fill={lc}/>
    </svg>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function TradeLog(props) {
  const { getToken, isDark, setIsDark, C } = props

  // ── State ──────────────────────────────────────────────────────────────────
  const [trades,     setTrades]     = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [filter,     setFilter]     = useState('open')
  const [section,    setSection]    = useState('log')   // 'log' | 'backtest'
  const [showAdd,    setShowAdd]    = useState(false)
  const [form,       setForm]       = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError,  setFormError]  = useState(null)
  const [closingId,  setClosingId]  = useState(null)
  const [closeForm,  setCloseForm]  = useState(EMPTY_CLOSE)
  const [closeError, setCloseError] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [btFilter,   setBtFilter]   = useState('all')

  // ── Styles derived from theme ──────────────────────────────────────────────
  const iSt = {
    width: '100%', background: C.inputBg, border: `1px solid ${C.border}`,
    borderRadius: 4, color: C.text, padding: '9px 12px', fontSize: 12,
    fontFamily: 'inherit', boxSizing: 'border-box', transition: 'border-color .15s',
  }
  const labelSt = {
    fontSize: 10, color: C.dim, letterSpacing: 1.2,
    marginBottom: 5, display: 'block', textTransform: 'uppercase',
  }
  const btnPrimary = {
    background: C.green, color: '#000', border: 'none', borderRadius: 4,
    padding: '9px 20px', fontSize: 12, fontFamily: 'inherit', letterSpacing: 1,
    cursor: 'pointer', fontWeight: 700, transition: 'opacity .15s',
  }
  const btnGhost = (col) => ({
    background: `${col}18`, color: col, border: `1px solid ${col}50`,
    borderRadius: 4, padding: '7px 14px', fontSize: 11,
    fontFamily: 'inherit', letterSpacing: .8, cursor: 'pointer', transition: 'all .15s',
  })

  // ── API helpers ────────────────────────────────────────────────────────────
  async function authHeaders() {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  async function loadTrades() {
    setLoading(true)
    try {
      const headers = await authHeaders()
      const res = await fetch('/api/user/trades', { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTrades(data.trades ?? [])
    } catch (e) { setError(e.message) }
    finally     { setLoading(false)  }
  }

  useEffect(() => { loadTrades() }, [])

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          symbol:      form.symbol.toUpperCase().trim(),
          option_type: form.option_type,
          action:      form.action,
          strike:      parseFloat(form.strike),
          expiration:  form.expiration,
          contracts:   parseInt(form.contracts) || 1,
          entry_price: parseFloat(form.premium),
          notes:       form.notes.trim() || null,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setForm(EMPTY_FORM); setShowAdd(false)
      await loadTrades()
    } catch (e) { setFormError(e.message) }
    finally     { setSubmitting(false) }
  }

  async function handleClose(id) {
    setCloseError(null)
    if (!closeForm.exit_price) { setCloseError('Exit price is required.'); return }
    setSubmitting(true)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/user/trades?id=${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          exit_price: parseFloat(closeForm.exit_price),
          status: 'closed',
          closed_at: new Date().toISOString(),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setClosingId(null); setCloseForm(EMPTY_CLOSE)
      await loadTrades()
    } catch (e) { setCloseError(e.message) }
    finally     { setSubmitting(false) }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this trade?')) return
    setDeletingId(id)
    try {
      const headers = await authHeaders()
      await fetch(`/api/user/trades?id=${id}`, { method: 'DELETE', headers })
      await loadTrades()
    } catch (e) { setError(e.message) }
    finally     { setDeletingId(null) }
  }

  // ── Derived data ───────────────────────────────────────────────────────────
  const openTrades   = trades.filter(t => (t.status ?? '').toLowerCase() !== 'closed' && !t.exit_price)
  const closedTrades = trades.filter(t => (t.status ?? '').toLowerCase() === 'closed' || t.exit_price)

  const totalPnl  = closedTrades.reduce((s, t) => s + (calcPnl(t) ?? parseFloat(t.pnl ?? 0)), 0)
  const winCount  = closedTrades.filter(t => (calcPnl(t) ?? parseFloat(t.pnl ?? 0)) > 0).length
  const lossCount = closedTrades.length - winCount
  const winRate   = closedTrades.length > 0 ? Math.round(winCount / closedTrades.length * 100) : null

  const displayed = filter === 'open'   ? openTrades
                  : filter === 'closed' ? closedTrades
                  : trades

  // ── Backtest analytics ─────────────────────────────────────────────────────
  const pnlOf    = t => calcPnl(t) ?? parseFloat(t.pnl ?? 0)
  const convOf   = t => parseFloat(t.conviction ?? 0)
  const ivOf     = t => parseFloat(t.iv ?? t.iv_at_entry ?? 0)
  const chgOf    = t => parseFloat(t.chgPctAtEntry ?? t.chg_pct_at_entry ?? 0)
  const beOf     = t => parseFloat(t.breakevenReqPct ?? t.be_req_pct ?? 0)
  const hbOf     = t => parseInt(t.hardBlockCount ?? t.hard_block_count ?? 0)
  const hasConv  = t => t.conviction && !isNaN(convOf(t))

  const wr  = arr => arr.length ? Math.round(arr.filter(t => pnlOf(t) > 0).length / arr.length * 100) : null
  const totPL = arr => arr.reduce((s, t) => s + pnlOf(t), 0)
  const avgPL = arr => arr.length ? totPL(arr) / arr.length : 0

  const hi90   = closedTrades.filter(t => hasConv(t) && convOf(t) >= 90)
  const hi70   = closedTrades.filter(t => hasConv(t) && convOf(t) >= 70 && convOf(t) < 90)
  const lo70   = closedTrades.filter(t => hasConv(t) && convOf(t) < 70)
  const wouldBlock = t => ivOf(t) > 55 || Math.abs(chgOf(t)) > 2 || hbOf(t) > 0
  const blocked    = closedTrades.filter(t => hasConv(t) && wouldBlock(t))
  const passed     = closedTrades.filter(t => hasConv(t) && !wouldBlock(t))

  const wins    = closedTrades.filter(t => pnlOf(t) > 0)
  const losses  = closedTrades.filter(t => pnlOf(t) < 0)
  const expectancy = (() => {
    const w = closedTrades.length ? winCount / closedTrades.length : 0
    const aw = wins.length ? Math.abs(avgPL(wins)) : 0
    const al = losses.length ? Math.abs(avgPL(losses)) : 1
    return w * aw - (1 - w) * al
  })()

  const btDisplayList = btFilter === '90plus'  ? closedTrades.filter(t => convOf(t) >= 90)
                       : btFilter === 'blocked' ? closedTrades.filter(wouldBlock)
                       : btFilter === 'passed'  ? closedTrades.filter(t => !wouldBlock(t) && hasConv(t))
                       : btFilter === 'open'    ? openTrades
                       : closedTrades

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: C.bg, minHeight: '100vh',
      fontFamily: "'IBM Plex Mono', monospace",
      color: C.text, paddingBottom: 80,
      transition: 'background .25s, color .25s',
    }}>
      <style>{`
        *{box-sizing:border-box}
        input:focus,select:focus,textarea:focus{outline:none;border-color:${C.green}!important}
        select option{background:${C.inputBg};color:${C.text}}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px}
        .tl-row:hover{background:${C.cardAlt}!important}
        .tl-btn:hover{opacity:.75}
      `}</style>

      <AppNav
        isDark={isDark} setIsDark={setIsDark} C={C}
        {...props}
        tab={null} setTab={() => {}}
        showTools={false} setShowTools={() => {}}
      />

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>

        {/* ── Page header ── */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 28, letterSpacing: 3, color: C.green, margin: 0, lineHeight: 1,
          }}>TRADE LOG</h1>
          <p style={{ fontSize: 10, color: C.dim, marginTop: 5, letterSpacing: 1 }}>
            {trades.length} trades · {openTrades.length} open · {closedTrades.length} closed
          </p>
        </div>

        {/* ── Summary cards ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10, marginBottom: 24,
        }}>
          <StatCard label="Open Positions" value={openTrades.length} color={C.blue} C={C}/>
          <StatCard label="Closed Trades"  value={closedTrades.length} color={C.dim} C={C}/>
          <StatCard
            label="Total P&L"
            value={closedTrades.length ? fmtDollar(totalPnl) : '—'}
            color={totalPnl >= 0 ? C.green : C.red} C={C}
          />
          <StatCard
            label="Win Rate"
            value={winRate !== null ? `${winRate}%` : '—'}
            color={winRate === null ? C.dim : winRate >= 50 ? C.green : C.red} C={C}
          />
        </div>

        {/* ── Section tabs: Log / Backtest ── */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
          {['log', 'backtest'].map(s => (
            <FilterTab
              key={s} label={s === 'log' ? '📋 TRADE LOG' : '📊 BACKTEST'}
              active={section === s} onClick={() => setSection(s)} C={C}
            />
          ))}
        </div>

        {/* ════════════════ TRADE LOG SECTION ════════════════ */}
        {section === 'log' && (
          <>
            {/* Toolbar */}
            <div style={{
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', marginBottom: 14,
              flexWrap: 'wrap', gap: 8,
            }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <FilterTab label="OPEN"   count={openTrades.length}   active={filter==='open'}   onClick={() => setFilter('open')}   C={C}/>
                <FilterTab label="CLOSED" count={closedTrades.length} active={filter==='closed'} onClick={() => setFilter('closed')} C={C}/>
                <FilterTab label="ALL"    count={trades.length}       active={filter==='all'}    onClick={() => setFilter('all')}    C={C}/>
              </div>
              <button className="tl-btn" onClick={() => { setShowAdd(p => !p); setFormError(null) }} style={btnGhost(C.green)}>
                {showAdd ? '✕ CANCEL' : '+ LOG TRADE'}
              </button>
            </div>

            {/* ── Add trade form ── */}
            {showAdd && (
              <div style={{
                background: C.card, border: `1px solid ${C.green}40`,
                borderRadius: 8, padding: '20px', marginBottom: 20,
              }}>
                <div style={{ fontSize: 11, color: C.green, letterSpacing: 2, marginBottom: 16 }}>NEW TRADE</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
                  {[
                    { label: 'Symbol',    field: 'symbol',      placeholder: 'SPY', type: 'text' },
                    { label: 'Strike',    field: 'strike',      placeholder: '500', type: 'number' },
                    { label: 'Contracts', field: 'contracts',   placeholder: '1',   type: 'number' },
                    { label: 'Premium',   field: 'premium',     placeholder: '2.50',type: 'number', step: '0.01' },
                  ].map(f => (
                    <div key={f.field}>
                      <label style={labelSt}>{f.label}</label>
                      <input style={iSt} type={f.type} placeholder={f.placeholder} step={f.step}
                        value={form[f.field]}
                        onChange={e => setForm(p => ({ ...p, [f.field]: f.field === 'symbol' ? e.target.value.toUpperCase() : e.target.value }))}
                      />
                    </div>
                  ))}
                  <div>
                    <label style={labelSt}>Type</label>
                    <select style={iSt} value={form.option_type} onChange={e => setForm(p => ({ ...p, option_type: e.target.value }))}>
                      <option value="call">CALL</option>
                      <option value="put">PUT</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelSt}>Action</label>
                    <select style={iSt} value={form.action} onChange={e => setForm(p => ({ ...p, action: e.target.value }))}>
                      <option value="buy">BUY</option>
                      <option value="sell">SELL</option>
                    </select>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={labelSt}>Expiration</label>
                    <input style={iSt} type="date" value={form.expiration}
                      onChange={e => setForm(p => ({ ...p, expiration: e.target.value }))}
                    />
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={labelSt}>Notes (optional)</label>
                  <input style={iSt} placeholder="e.g. high edge score, earnings play…"
                    value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                  />
                </div>
                {formError && <div style={{ color: C.red, fontSize: 11, marginTop: 10 }}>{formError}</div>}
                <div style={{ marginTop: 16 }}>
                  <button className="tl-btn" onClick={handleAdd} disabled={submitting} style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}>
                    {submitting ? 'SAVING…' : 'SAVE TRADE'}
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{
                background: `${C.red}15`, border: `1px solid ${C.red}40`,
                borderRadius: 6, padding: '12px 16px', color: C.red,
                fontSize: 12, marginBottom: 16,
              }}>⚠ {error}</div>
            )}

            {/* Loading */}
            {loading && (
              <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', padding: 40, letterSpacing: 2 }}>LOADING…</div>
            )}

            {/* Empty */}
            {!loading && displayed.length === 0 && (
              <div style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '40px 20px', textAlign: 'center', color: C.dim, fontSize: 12,
              }}>
                {filter === 'open' ? 'No open positions. Click + LOG TRADE to add one.'
                 : filter === 'closed' ? 'No closed trades yet.'
                 : 'No trades logged yet.'}
              </div>
            )}

            {/* ── Trade table ── */}
            {!loading && displayed.length > 0 && (
              <div style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 8, overflow: 'hidden',
              }}>
                {/* Table header */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '80px 50px 50px 70px 90px 50px 70px 70px 1fr 100px',
                  padding: '10px 16px',
                  borderBottom: `1px solid ${C.border}`,
                  fontSize: 9, color: C.dim, letterSpacing: 1.5,
                  background: C.bgAlt,
                }}>
                  {['SYMBOL','TYPE','SIDE','STRIKE','EXP','QTY','ENTRY','EXIT','P&L',''].map((h, i) => (
                    <span key={i} style={{ textAlign: i === 9 ? 'right' : 'left' }}>{h}</span>
                  ))}
                </div>

                {/* Rows */}
                {displayed.map((trade, i) => {
                  const isClosed  = (trade.status ?? '').toLowerCase() === 'closed' || !!trade.exit_price
                  const isClosing = closingId === trade.id
                  const pnl = calcPnl(trade)
                  const rowBg = i % 2 === 0 ? 'transparent' : C.cardAlt

                  return (
                    <div key={trade.id}>
                      <div
                        className="tl-row"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '80px 50px 50px 70px 90px 50px 70px 70px 1fr 100px',
                          padding: '11px 16px',
                          background: rowBg,
                          borderBottom: `1px solid ${C.border}30`,
                          alignItems: 'center', fontSize: 11,
                          opacity: isClosed ? 0.65 : 1,
                          transition: 'background .1s',
                        }}
                      >
                        <span style={{ color: C.blue, fontWeight: 700, fontSize: 12 }}>
                          {trade.symbol ?? trade.ticker}
                        </span>
                        <span style={{
                          color: (trade.option_type ?? trade.type ?? '').toLowerCase() === 'call' ? C.green : C.orange,
                          fontSize: 10, textTransform: 'uppercase',
                        }}>
                          {(trade.option_type ?? trade.type ?? '').slice(0, 4)}
                        </span>
                        <span style={{
                          color: (trade.action ?? 'buy').toLowerCase() === 'buy' ? C.green : C.red,
                          fontSize: 10, textTransform: 'uppercase',
                        }}>
                          {(trade.action ?? 'buy').toUpperCase()}
                        </span>
                        <span>${fmt(trade.strike, 0)}</span>
                        <span style={{ color: C.dim, fontSize: 10 }}>
                          {trade.expiration ?? trade.expiry ?? '—'}
                        </span>
                        <span>{trade.contracts ?? 1}</span>
                        <span>${fmt(trade.entry_price ?? trade.entry)}</span>
                        <span style={{ color: isClosed ? C.text : C.dim }}>
                          {isClosed ? `$${fmt(trade.exit_price ?? trade.exitPrice)}` : '—'}
                        </span>
                        <span>
                          {pnl !== null
                            ? <span style={{ color: pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>
                                {pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(0)}
                              </span>
                            : <span style={{ color: C.dim }}>—</span>
                          }
                        </span>
                        <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                          {!isClosed && (
                            <button className="tl-btn" onClick={() => {
                              setClosingId(isClosing ? null : trade.id)
                              setCloseForm(EMPTY_CLOSE); setCloseError(null)
                            }} style={{
                              ...btnGhost(C.orange), padding: '4px 9px', fontSize: 10,
                            }}>
                              {isClosing ? 'CANCEL' : 'CLOSE'}
                            </button>
                          )}
                          <button className="tl-btn" onClick={() => handleDelete(trade.id)}
                            disabled={deletingId === trade.id}
                            style={{
                              background: `${C.red}15`, color: C.red,
                              border: `1px solid ${C.red}40`, borderRadius: 4,
                              padding: '4px 8px', fontSize: 10, cursor: 'pointer',
                              opacity: deletingId === trade.id ? 0.5 : 1,
                            }}>✕</button>
                        </div>
                      </div>

                      {/* Inline close form */}
                      {isClosing && (
                        <div style={{
                          background: `${C.orange}08`,
                          borderBottom: `1px solid ${C.orange}30`,
                          padding: '12px 16px',
                          display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
                        }}>
                          <div>
                            <label style={{ ...labelSt, color: C.orange }}>EXIT PRICE / CONTRACT</label>
                            <input autoFocus style={{ ...iSt, width: 150, border: `1px solid ${C.orange}50` }}
                              type="number" step="0.01" placeholder="e.g. 4.20"
                              value={closeForm.exit_price}
                              onChange={e => setCloseForm({ exit_price: e.target.value })}
                            />
                          </div>
                          {closeForm.exit_price && (
                            <div style={{ fontSize: 11, color: C.dim, paddingBottom: 10 }}>
                              Est. P&L:&nbsp;
                              <PnlBadge trade={{ ...trade, exit_price: parseFloat(closeForm.exit_price) }} C={C}/>
                            </div>
                          )}
                          {closeError && <div style={{ color: C.red, fontSize: 11 }}>{closeError}</div>}
                          <button className="tl-btn" onClick={() => handleClose(trade.id)} disabled={submitting}
                            style={{ ...btnPrimary, background: C.orange, opacity: submitting ? 0.6 : 1 }}>
                            {submitting ? 'SAVING…' : 'CONFIRM CLOSE'}
                          </button>
                        </div>
                      )}

                      {/* Notes sub-row */}
                      {trade.notes && (
                        <div style={{
                          background: rowBg, borderBottom: `1px solid ${C.border}20`,
                          padding: '4px 16px 8px', fontSize: 10, color: C.dim,
                        }}>↳ {trade.notes}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Win/loss summary bar */}
            {closedTrades.length > 0 && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                {[
                  { label: 'WINS',     value: winCount,                    color: C.green },
                  { label: 'LOSSES',   value: lossCount,                   color: C.red   },
                  { label: 'WIN RATE', value: winRate !== null ? `${winRate}%` : '—', color: winRate >= 50 ? C.green : C.red },
                  { label: 'TOTAL P&L',value: fmtDollar(totalPnl),         color: totalPnl >= 0 ? C.green : C.red },
                ].map(s => (
                  <div key={s.label} style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: 6, padding: '8px 16px',
                    display: 'flex', gap: 8, alignItems: 'center',
                  }}>
                    <span style={{ fontSize: 9, color: C.dim, letterSpacing: 1 }}>{s.label}</span>
                    <span style={{ fontSize: 13, color: s.color, fontWeight: 700 }}>{s.value}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ════════════════ BACKTEST SECTION ════════════════ */}
        {section === 'backtest' && (
          <div>
            {closedTrades.length === 0 ? (
              <div style={{
                background: C.card, border: `1px dashed ${C.border}`,
                borderRadius: 8, padding: 32, textAlign: 'center',
              }}>
                <div style={{ fontSize: 14, color: C.dim, marginBottom: 10 }}>No closed trades to analyze</div>
                <div style={{ fontSize: 11, color: C.subtext, lineHeight: 1.8 }}>
                  Close trades in the Trade Log tab to see backtest analytics here.
                </div>
              </div>
            ) : (
              <>
                {/* Summary stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 20 }}>
                  {[
                    { l: 'TOTAL P&L',   v: fmtDollar(totPL(closedTrades)),      c: totPL(closedTrades) >= 0 ? C.green : C.red },
                    { l: 'WIN RATE',    v: wr(closedTrades) + '%',               c: wr(closedTrades) >= 60 ? C.green : wr(closedTrades) >= 45 ? C.orange : C.red },
                    { l: 'EXPECTANCY',  v: fmtDollar(expectancy) + '/trade',     c: expectancy >= 0 ? C.green : C.red },
                    { l: 'AVG WIN',     v: wins.length ? '+$' + Math.abs(avgPL(wins)).toFixed(0) : '—', c: C.green },
                    { l: 'AVG LOSS',    v: losses.length ? '-$' + Math.abs(avgPL(losses)).toFixed(0) : '—', c: C.red },
                    { l: 'W / L',       v: `${wins.length}W / ${losses.length}L`, c: C.dim },
                  ].map((s, i) => (
                    <div key={i} style={{
                      background: C.card, border: `1px solid ${C.border}`,
                      borderRadius: 8, padding: '12px 14px',
                    }}>
                      <div style={{ fontSize: 8, color: C.dim, letterSpacing: 2, marginBottom: 4 }}>{s.l}</div>
                      <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, color: s.c, letterSpacing: 1 }}>{s.v}</div>
                    </div>
                  ))}
                </div>

                {/* Equity curve */}
                <div style={{
                  background: C.card, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: '16px', marginBottom: 16,
                }}>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>EQUITY CURVE</div>
                  <EquityCurve trades={closedTrades} C={C}/>
                </div>

                {/* Filter impact: blocked vs passed */}
                {(blocked.length > 0 || passed.length > 0) && (
                  <div style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: '16px', marginBottom: 16,
                  }}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>FILTER IMPACT ANALYSIS</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div style={{
                        background: C.cardAlt, border: `1px solid ${C.red}40`,
                        borderRadius: 6, padding: '12px',
                      }}>
                        <div style={{ fontSize: 9, color: C.red, letterSpacing: 1.5, marginBottom: 6 }}>🚫 WOULD BLOCK</div>
                        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: C.red }}>{blocked.length}</div>
                        <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>trades flagged</div>
                        {wr(blocked) !== null && <div style={{ fontSize: 11, color: C.red, marginTop: 6 }}>Actual WR: <strong>{wr(blocked)}%</strong></div>}
                        <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>
                          P&L: <span style={{ color: totPL(blocked) <= 0 ? C.green : C.red }}>
                            {totPL(blocked) <= 0 ? 'Saved' : 'Lost'} ${Math.abs(totPL(blocked)).toFixed(0)}
                          </span>
                        </div>
                      </div>
                      <div style={{
                        background: C.cardAlt, border: `1px solid ${C.green}40`,
                        borderRadius: 6, padding: '12px',
                      }}>
                        <div style={{ fontSize: 9, color: C.green, letterSpacing: 1.5, marginBottom: 6 }}>✅ PASSES FILTERS</div>
                        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: C.green }}>{passed.length}</div>
                        <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>clean setups</div>
                        {wr(passed) !== null && <div style={{ fontSize: 11, color: C.green, marginTop: 6 }}>Win rate: <strong>{wr(passed)}%</strong></div>}
                        <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>
                          P&L: <span style={{ color: totPL(passed) >= 0 ? C.green : C.red }}>${totPL(passed).toFixed(0)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Conviction bands */}
                {(hi90.length > 0 || hi70.length > 0 || lo70.length > 0) && (
                  <div style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: '16px', marginBottom: 16,
                  }}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>WIN RATE BY CONVICTION BAND</div>
                    {[
                      { label: '90%+  HIGH CONVICTION', arr: hi90, color: C.green },
                      { label: '70–89%  MODERATE',      arr: hi70, color: C.orange },
                      { label: '<70%   LOW',             arr: lo70, color: C.red   },
                    ].filter(b => b.arr.length > 0).map((b, i) => {
                      const bWr = wr(b.arr), bPL = totPL(b.arr)
                      const w = b.arr.filter(t => pnlOf(t) > 0).length
                      return (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 12px', borderRadius: 6, marginBottom: 6,
                          background: C.cardAlt, border: `1px solid ${b.color}30`,
                        }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: b.color, letterSpacing: 1, marginBottom: 3 }}>{b.label}</div>
                            <div style={{ fontSize: 10, color: C.dim }}>
                              {b.arr.length} trades · {w}W/{b.arr.length - w}L ·{' '}
                              <span style={{ color: bPL >= 0 ? C.green : C.red }}>{bPL >= 0 ? '+' : ''}${bPL.toFixed(0)}</span>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, color: bWr >= 60 ? C.green : bWr >= 45 ? C.orange : C.red, lineHeight: 1 }}>{bWr}%</div>
                            <div style={{ fontSize: 8, color: C.dim }}>win rate</div>
                          </div>
                          <div style={{ width: 44, height: 5, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: (bWr ?? 0) + '%', height: '100%', background: b.color, borderRadius: 3 }}/>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* IV analysis */}
                {closedTrades.filter(t => ivOf(t) > 0).length >= 2 && (
                  <div style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: '16px', marginBottom: 16,
                  }}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>OUTCOME BY IV AT ENTRY</div>
                    {[
                      { label: 'Low IV (<40%)',      arr: closedTrades.filter(t => ivOf(t) > 0 && ivOf(t) < 40),  color: C.green  },
                      { label: 'Moderate (40–55%)',  arr: closedTrades.filter(t => ivOf(t) >= 40 && ivOf(t) <= 55), color: C.orange },
                      { label: 'High IV (>55%)',     arr: closedTrades.filter(t => ivOf(t) > 55),                  color: C.red    },
                    ].filter(b => b.arr.length > 0).map((b, i) => {
                      const bWr = wr(b.arr), bPL = totPL(b.arr)
                      const w = b.arr.filter(t => pnlOf(t) > 0).length
                      return (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 12px', borderRadius: 6, marginBottom: 6,
                          background: C.cardAlt, border: `1px solid ${b.color}30`,
                        }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: b.color, letterSpacing: 1, marginBottom: 3 }}>{b.label}</div>
                            <div style={{ fontSize: 10, color: C.dim }}>
                              {b.arr.length} trades · {w}W/{b.arr.length - w}L ·{' '}
                              <span style={{ color: bPL >= 0 ? C.green : C.red }}>{bPL >= 0 ? '+' : ''}${bPL.toFixed(0)}</span>
                            </div>
                          </div>
                          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 24, color: bWr >= 60 ? C.green : bWr >= 45 ? C.orange : C.red }}>
                            {bWr}%
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Trade list with filter */}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
                  {[
                    { id: 'all',     label: 'All Closed' },
                    { id: '90plus',  label: '90%+ Only' },
                    { id: 'blocked', label: 'Would Block' },
                    { id: 'passed',  label: 'Clean Setups' },
                    { id: 'open',    label: 'Open / Paper' },
                  ].map(f => (
                    <FilterTab
                      key={f.id} label={f.label}
                      count={
                        f.id === 'all'     ? closedTrades.length
                      : f.id === '90plus'  ? closedTrades.filter(t => convOf(t) >= 90).length
                      : f.id === 'blocked' ? blocked.length
                      : f.id === 'passed'  ? passed.length
                      : openTrades.length
                      }
                      active={btFilter === f.id} onClick={() => setBtFilter(f.id)} C={C}
                    />
                  ))}
                </div>

                {btDisplayList.length === 0 ? (
                  <div style={{ fontSize: 11, color: C.dim, textAlign: 'center', padding: 20, border: `1px dashed ${C.border}`, borderRadius: 6 }}>
                    No trades in this filter
                  </div>
                ) : btDisplayList.map((t, i) => {
                  const p = pnlOf(t), isWin = p > 0, isLoss = p < 0
                  const stC = (t.status ?? 'open').toLowerCase() === 'open' ? C.blue : isWin ? C.green : isLoss ? C.red : C.dim
                  const bl = wouldBlock(t)
                  return (
                    <div key={t.id ?? i} style={{
                      background: C.card, border: `1px solid ${C.border}`,
                      borderLeft: `3px solid ${stC}`, borderRadius: 6,
                      padding: '11px 14px', marginBottom: 6,
                      transition: 'background .15s',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, color: C.text, letterSpacing: 2 }}>
                            {t.symbol ?? t.ticker}
                          </span>
                          <span style={{ fontSize: 9, color: stC, border: `1px solid ${stC}40`, padding: '2px 6px', borderRadius: 3 }}>
                            {(t.status ?? 'OPEN').toUpperCase()}
                          </span>
                          <span style={{ fontSize: 10, color: C.dim }}>{t.option_type ?? t.type}</span>
                          {(t.strike) && <span style={{ fontSize: 10, color: C.dim }}>${fmt(t.strike, 0)}</span>}
                          {(t.expiration ?? t.expiry) && <span style={{ fontSize: 9, color: C.subtext }}>{t.expiration ?? t.expiry}</span>}
                          {t.conviction && <span style={{ fontSize: 9, color: C.blue, border: `1px solid ${C.blue}30`, padding: '1px 5px', borderRadius: 2 }}>{t.conviction}%</span>}
                          {bl && <span style={{ fontSize: 8, color: C.red, border: `1px solid ${C.red}40`, padding: '1px 5px', borderRadius: 2 }}>🚫 BLOCKED</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          {p !== 0 && (
                            <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, color: isWin ? C.green : C.red }}>
                              {p >= 0 ? '+' : '-'}${Math.abs(p).toFixed(0)}
                            </span>
                          )}
                          {(t.status ?? 'open').toLowerCase() === 'open' && (
                            <span style={{ fontSize: 9, color: C.orange, border: `1px solid ${C.orange}40`, padding: '1px 5px', borderRadius: 2 }}>PAPER</span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: C.dim, flexWrap: 'wrap' }}>
                        {(t.entry_price ?? t.entry) && <span>Entry: <span style={{ color: C.subtext }}>${fmt(t.entry_price ?? t.entry)}</span></span>}
                        {(t.exit_price ?? t.exitPrice) && <span>Exit: <span style={{ color: C.subtext }}>${fmt(t.exit_price ?? t.exitPrice)}</span></span>}
                        {ivOf(t) > 0 && <span>IV: <span style={{ color: ivOf(t) > 55 ? C.red : ivOf(t) > 40 ? C.orange : C.green }}>{ivOf(t).toFixed(0)}%</span></span>}
                        {chgOf(t) !== 0 && <span>Stk Δ: <span style={{ color: Math.abs(chgOf(t)) > 2 ? C.red : C.subtext }}>{chgOf(t) > 0 ? '+' : ''}{chgOf(t).toFixed(1)}%</span></span>}
                        {beOf(t) > 0 && <span>BE req: <span style={{ color: beOf(t) > 5 ? C.red : beOf(t) > 3 ? C.orange : C.green }}>+{beOf(t).toFixed(1)}%</span></span>}
                      </div>
                      {t.notes && <div style={{ marginTop: 5, fontSize: 10, color: C.subtext, lineHeight: 1.6 }}>{t.notes}</div>}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
