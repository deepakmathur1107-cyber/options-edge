/**
 * src/pages/TradeLog.jsx
 * Route: /app/trades
 * Unified trade journal + backtest — fully theme-aware, modern UI
 */
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AppNav from '../components/AppNav'

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt    = (v, d=2) => { const n=parseFloat(v); return isNaN(n)?'—':n.toFixed(d) }
const fmtUSD = (v) => { const n=parseFloat(v); if(isNaN(n)) return '—'; return (n>=0?'+$':'-$')+Math.abs(n).toFixed(0) }
// fmtExpiry — trades.expiration is now a raw ISO date ("2026-07-17") for
// trades logged after the verdict-engine expiry_raw fix (same session),
// since buildOccSymbol needs that exact format. Older trades may still
// carry the old display-string format ("Jul 17, 2026") from before that
// fix, or trade.expiry (a SEPARATE field, always a display string,
// untouched by that fix) as a fallback. This renders either shape
// correctly rather than showing a raw "2026-07-17" to the user, which
// would be a visible regression introduced by a backend-only fix.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const fmtExpiry = (v) => {
  if (!v) return '—'
  if (ISO_DATE_RE.test(v)) {
    const d = new Date(v + 'T12:00:00')
    return isNaN(d) ? v : d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
  }
  return v   // already a display string (old trades, or trade.expiry fallback)
}

function calcPnl(trade) {
  const entry = parseFloat(trade.entry_price ?? trade.entry ?? 0)
  const exit  = parseFloat(trade.exit_price  ?? trade.exitPrice ?? 0)
  const qty   = parseInt(trade.contracts ?? 1)
  const side  = (trade.action ?? trade.side ?? 'buy').toLowerCase()
  if (!exit || !entry) return null
  return side === 'sell' ? (entry - exit)*qty*100 : (exit - entry)*qty*100
}

function calcR(trade) {
  const pnl=calcPnl(trade)
  const entry=parseFloat(trade.entry_price??trade.entry)
  const stop=parseFloat(trade.stop_price??trade.stop)
  const qty=parseInt(trade.contracts??1)
  const plannedRisk=Math.abs(entry-stop)*qty*100
  return pnl===null||!Number.isFinite(plannedRisk)||plannedRisk<=0?null:pnl/plannedRisk
}

// A trade only has a real, computable P&L if calcPnl didn't have to bail
// (missing/zero entry or exit price). Previously, closed-trade stats fell
// back to `parseFloat(t.pnl ?? 0)` whenever calcPnl returned null — since
// trades.pnl is never actually populated on close (confirmed: both of the
// 2 live closed trades have pnl=null), that fallback resolved to 0, which
// then silently counted as a LOSS in win-rate math (losses filter is
// `<=0`) rather than being excluded as "unknown." Harmless today only
// because both real closed trades happen to have exit_price set — this
// guards against that breaking once trades are closed at higher volume
// (e.g. by the autonomous paper-trade close logic) where a bug or edge
// case could write status='Closed' without exit_price.
const hasValidExit = trade => calcPnl(trade) !== null

const EMPTY_FORM = {
  symbol:'', option_type:'call', action:'buy',
  strike:'', expiration:'', contracts:'1', entry_price:'', notes:'',
}
const EMPTY_CLOSE = { exit_price:'' }

// ── Equity Curve ──────────────────────────────────────────────────────────────
function EquityCurve({ trades, C }) {
  const closed = trades
    .filter(t => ((t.status??'').toLowerCase()==='closed' || t.exit_price) && hasValidExit(t))
    .slice().reverse()
  if (closed.length < 2) return (
    <div style={{
      textAlign:'center', padding:'32px 0', color:C.dim,
      border:`1px dashed ${C.border}`, borderRadius:8, fontSize:13,
    }}>
      <div style={{fontSize:24, marginBottom:8}}>📈</div>
      Log 2+ closed trades to see your equity curve
    </div>
  )
  const W=500, H=100
  const cumPnl = closed.reduce((acc,t)=>{
    const prev = acc[acc.length-1]?.y ?? 0
    const p = calcPnl(t)
    acc.push({ y: prev+p })
    return acc
  },[])
  const vals = cumPnl.map(p=>p.y)
  const minV = Math.min(0,...vals), maxV = Math.max(0,...vals)
  const range = maxV-minV || 1
  const toY = v => H - ((v-minV)/range)*H*0.82 - H*0.06
  const pts = cumPnl.map((p,i)=>`${(i/(cumPnl.length-1))*W},${toY(p.y)}`).join(' ')
  const lastY = cumPnl[cumPnl.length-1].y
  const lc = lastY >= 0 ? C.green : C.red
  const zeroY = toY(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,display:'block'}}>
      <defs>
        <linearGradient id="ecg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={lc} stopOpacity=".2"/>
          <stop offset="100%" stopColor={lc} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={C.border} strokeWidth={1} strokeDasharray="4,3"/>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#ecg)"/>
      <polyline points={pts} fill="none" stroke={lc} strokeWidth={2.5}/>
      <circle cx={(cumPnl.length-1)/(cumPnl.length-1)*W} cy={toY(lastY)} r={4} fill={lc} stroke={C.card} strokeWidth={2}/>
    </svg>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function TradeLog(props) {
  const { getToken, isDark, setIsDark, C } = props
  const navigate = useNavigate()

  // ── State ──────────────────────────────────────────────────────────────────
  const [trades,     setTrades]     = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [filter,     setFilter]     = useState('open')
  const [section,    setSection]    = useState('log')
  const [showAdd,    setShowAdd]    = useState(false)
  const [form,       setForm]       = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError,  setFormError]  = useState(null)
  const [closingId,  setClosingId]  = useState(null)
  // expandedVerdictId — mirrors closingId's pattern. Tracks which trade's
  // verdict-check history (if any) is currently expanded below its row.
  const [expandedVerdictId, setExpandedVerdictId] = useState(null)
  const [verdictHistory, setVerdictHistory] = useState({})   // tradeId -> rows[], fetched on-demand
  const [verdictHistoryLoading, setVerdictHistoryLoading] = useState(null)
  const [closeForm,  setCloseForm]  = useState(EMPTY_CLOSE)
  const [closeError, setCloseError] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [btFilter,   setBtFilter]   = useState('all')

  // ── Derived theme values ───────────────────────────────────────────────────
  const shadow   = isDark
    ? '0 1px 3px rgba(0,0,0,.4), 0 1px 2px rgba(0,0,0,.3)'
    : '0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.05)'
  const shadowMd = isDark
    ? '0 4px 12px rgba(0,0,0,.5), 0 2px 4px rgba(0,0,0,.3)'
    : '0 4px 12px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05)'

  const iSt = {
    width:'100%', background:C.inputBg,
    border:`1px solid ${C.border}`, borderRadius:6,
    color:C.text, padding:'10px 14px', fontSize:13,
    fontFamily:"'Inter', 'IBM Plex Mono', sans-serif",
    boxSizing:'border-box', transition:'border-color .15s, box-shadow .15s',
    outline:'none',
  }

  // ── API helpers ────────────────────────────────────────────────────────────
  async function authHeaders() {
    const token = await getToken()
    if (!token) throw new Error('Session expired — please sign out and sign back in.')
    return { Authorization:`Bearer ${token}` }
  }

  async function loadTrades() {
    setLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch('/api/user/trades', { headers:h })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setTrades(d.trades ?? [])
    } catch(e) { setError(e.message) }
    finally    { setLoading(false)  }
  }

  // suggestions — pending trade_close_suggestions for this user's trades.
  // Fetched once on page load alongside loadTrades, NOT per-row on demand
  // like verdictHistory — there are typically few of these at once and a
  // user should see them immediately on opening the page, not have to
  // click into each trade to discover one exists.
  const [suggestions, setSuggestions] = useState([])
  const [suggestionActionLoading, setSuggestionActionLoading] = useState(null)

  async function loadSuggestions() {
    try {
      const h = await authHeaders()
      const res = await fetch('/api/user/trade-suggestions', { headers:h })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setSuggestions(d.suggestions ?? [])
    } catch(e) {
      // Deliberately not surfacing this as a page-level error -- a failed
      // suggestions fetch shouldn't block the trade log itself from
      // showing. Logged for visibility, not shown to the user.
      console.error('[TradeLog] failed to load suggestions:', e.message)
    }
  }

  async function actOnSuggestion(suggestionId, action) {
    setSuggestionActionLoading(suggestionId)
    try {
      const h = await authHeaders()
      const res = await fetch(`/api/user/trade-suggestions?id=${suggestionId}`, {
        method: 'PUT',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      // Remove the acted-on suggestion locally rather than re-fetching the
      // whole list -- it's already resolved server-side, no need to round-
      // trip again just to learn that.
      setSuggestions(prev => prev.filter(s => s.id !== suggestionId))
      // A confirm closes the underlying trade server-side -- reload the
      // trade list so the now-closed trade reflects its new status/exit
      // price immediately, rather than showing stale "Open" until the
      // next manual refresh.
      if (action === 'confirm') await loadTrades()
    } catch(e) {
      setError(e.message)
    } finally {
      setSuggestionActionLoading(null)
    }
  }

  useEffect(() => { loadTrades(); loadSuggestions() }, [])

  async function handleAdd() {
    setFormError(null)
    if (!form.symbol||!form.strike||!form.expiration||!form.entry_price) {
      setFormError('Symbol, strike, expiration and premium are required.')
      return
    }
    setSubmitting(true)
    try {
      const h = await authHeaders()
      const res = await fetch('/api/user/trades', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', ...h },
        body: JSON.stringify({
          ticker:      form.symbol.toUpperCase().trim(),
          option_type: form.option_type,
          action:      form.action,
          strike:      parseFloat(form.strike),
          expiration:  form.expiration,
          contracts:   parseInt(form.contracts)||1,
          entry_price: parseFloat(form.entry_price),
          notes:       form.notes.trim()||null,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(()=>({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      setForm(EMPTY_FORM); setShowAdd(false)
      await loadTrades()
    } catch(e) { setFormError(e.message) }
    finally    { setSubmitting(false) }
  }

  async function handleClose(id) {
    setCloseError(null)
    if (!closeForm.exit_price) { setCloseError('Exit price required.'); return }
    setSubmitting(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`/api/user/trades?id=${id}`, {
        method:'PUT',
        headers:{ 'Content-Type':'application/json', ...h },
        body: JSON.stringify({
          exit_price: parseFloat(closeForm.exit_price),
          status:     'Closed',
          closed_at:  new Date().toISOString(),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(()=>({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      setClosingId(null); setCloseForm(EMPTY_CLOSE)
      await loadTrades()
    } catch(e) { setCloseError(e.message) }
    finally    { setSubmitting(false) }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this trade?')) return
    setDeletingId(id)
    try {
      const h = await authHeaders()
      await fetch(`/api/user/trades?id=${id}`, { method:'DELETE', headers:h })
      await loadTrades()
    } catch(e) { setError(e.message) }
    finally    { setDeletingId(null) }
  }

  // toggleVerdictHistory — expand/collapse a trade's verdict-check history.
  // Fetches on first expand only (cached in verdictHistory by tradeId) —
  // collapsing and re-expanding doesn't re-fetch. Deliberately a SEPARATE,
  // on-demand fetch, not part of loadTrades' main payload: most trades
  // won't have their history opened in a given session, so fetching all
  // history up front for every trade would be wasted work for the common
  // case (architect decision, same session as the live-recheck-on-load
  // tradeoff this mirrors).
  async function toggleVerdictHistory(tradeId) {
    if (expandedVerdictId === tradeId) {
      setExpandedVerdictId(null)
      return
    }
    setExpandedVerdictId(tradeId)
    if (verdictHistory[tradeId]) return   // already cached, don't re-fetch
    setVerdictHistoryLoading(tradeId)
    try {
      const h = await authHeaders()
      const res = await fetch(`/api/user/verdict-history?tradeId=${tradeId}`, { headers:h })
      const d = await res.json()
      setVerdictHistory(prev => ({ ...prev, [tradeId]: d.history ?? [] }))
    } catch(e) {
      setVerdictHistory(prev => ({ ...prev, [tradeId]: [] }))
    } finally {
      setVerdictHistoryLoading(null)
    }
  }

  // ── Derived data ───────────────────────────────────────────────────────────
  const openTrades   = trades.filter(t => (t.status??'').toLowerCase()!=='closed' && !t.exit_price)
  const closedTrades = trades.filter(t => (t.status??'').toLowerCase()==='closed'  || !!t.exit_price)

  // Stats below only consider trades where P&L is actually computable
  // (entry AND exit price present) — see hasValidExit's comment. A closed
  // trade missing exit_price is excluded from win/loss/total math rather
  // than being silently scored as a $0 loss.
  const statsEligible = closedTrades.filter(hasValidExit)
  const totalPnl = statsEligible.reduce((s,t)=> s + calcPnl(t), 0)
  const wins     = statsEligible.filter(t=>calcPnl(t)>0)
  const losses   = statsEligible.filter(t=>calcPnl(t)<=0)
  const winRate  = statsEligible.length ? Math.round(wins.length/statsEligible.length*100) : null

  // ── Streak — most-recently-CLOSED trade first, not most-recently-LOGGED.
  // Two trades opened the same day but closed on different days should
  // order by when their outcome became known, not when they were entered
  // — closed_at is the right anchor, created_at (the API's own default
  // order) is the wrong one for this specific calculation. Falls back to
  // created_at only if closed_at is somehow missing on an older row, same
  // defensive pattern fmtExpiry already uses elsewhere in this file for a
  // similar "newer rows have the right field, older ones might not" gap.
  const byRecentClose = [...statsEligible].sort((a, b) => {
    const aTime = new Date(a.closed_at || a.created_at).getTime()
    const bTime = new Date(b.closed_at || b.created_at).getTime()
    return bTime - aTime
  })
  let streakCount = 0
  let streakType  = null // 'win' | 'loss' | null
  for (const t of byRecentClose) {
    const isWin = calcPnl(t) > 0
    if (streakType === null) {
      streakType = isWin ? 'win' : 'loss'
      streakCount = 1
    } else if ((isWin && streakType === 'win') || (!isWin && streakType === 'loss')) {
      streakCount++
    } else {
      break
    }
  }

  // ── This week vs last week — same hasValidExit-filtered population,
  // bucketed by closed_at into two real calendar weeks (Mon-Sun, matching
  // how a trader actually thinks about "this week"), not a rolling 7-day
  // window. Returns null (not 0%) for a week with zero eligible closes —
  // same "don't fabricate a number from an empty set" rule track-record.js
  // and conviction-correlation.js already both follow.
  function startOfWeek(d) {
    const date = new Date(d)
    const day = date.getDay() // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day // shift to Monday
    date.setDate(date.getDate() + diff)
    date.setHours(0,0,0,0)
    return date
  }
  const now = new Date()
  const thisWeekStart = startOfWeek(now)
  const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7)
  const thisWeekRows = statsEligible.filter(t => {
    const d = new Date(t.closed_at || t.created_at)
    return d >= thisWeekStart
  })
  const lastWeekRows = statsEligible.filter(t => {
    const d = new Date(t.closed_at || t.created_at)
    return d >= lastWeekStart && d < thisWeekStart
  })
  const winRateOf = rows => rows.length ? Math.round(rows.filter(t=>calcPnl(t)>0).length/rows.length*100) : null
  const thisWeekWinRate = winRateOf(thisWeekRows)
  const lastWeekWinRate = winRateOf(lastWeekRows)

  const displayed = filter==='open'   ? openTrades
                  : filter==='closed' ? closedTrades
                  : trades

  // ── Backtest helpers ───────────────────────────────────────────────────────
  // pnlOf returns null for trades calcPnl can't compute (missing exit price)
  // rather than falling back to a stored pnl that's never actually populated
  // — see hasValidExit's comment above for why that fallback silently miscounted
  // as a $0 loss. wr/totPL/avgPL filter those out explicitly so a caller that
  // forgets to pre-filter still gets correct math instead of deflated stats.
  const pnlOf   = t => calcPnl(t)
  const convOf  = t => parseFloat(t.conviction??0)
  const ivOf    = t => parseFloat(t.iv??t.iv_at_entry??0)
  const chgOf   = t => parseFloat(t.chgPctAtEntry??t.chg_pct_at_entry??0)
  const beOf    = t => parseFloat(t.breakevenReqPct??t.be_req_pct??0)
  const hbOf    = t => parseInt(t.hardBlockCount??t.hard_block_count??0)
  const hasConv = t => t.conviction && !isNaN(convOf(t))

  const wr    = arr => { const e=arr.filter(hasValidExit); return e.length ? Math.round(e.filter(t=>pnlOf(t)>0).length/e.length*100) : null }
  const totPL = arr => arr.filter(hasValidExit).reduce((s,t)=>s+pnlOf(t), 0)
  const avgPL = arr => { const e=arr.filter(hasValidExit); return e.length ? totPL(e)/e.length : 0 }

  const hi90      = closedTrades.filter(t=>hasConv(t)&&convOf(t)>=90)
  const hi70      = closedTrades.filter(t=>hasConv(t)&&convOf(t)>=70&&convOf(t)<90)
  const lo70      = closedTrades.filter(t=>hasConv(t)&&convOf(t)<70)
  const wouldBlock= t => ivOf(t)>55 || Math.abs(chgOf(t))>2 || hbOf(t)>0
  const blocked   = closedTrades.filter(t=>hasConv(t)&&wouldBlock(t))
  const passed    = closedTrades.filter(t=>hasConv(t)&&!wouldBlock(t))
  const avgWin    = wins.length   ? Math.abs(avgPL(wins))   : 0
  const avgLoss   = losses.length ? Math.abs(avgPL(losses)) : 0
  const expectancy= statsEligible.length
    ? (wins.length/statsEligible.length)*avgWin - (losses.length/statsEligible.length)*avgLoss
    : 0

  const btList = btFilter==='90plus'  ? closedTrades.filter(t=>convOf(t)>=90)
               : btFilter==='blocked' ? closedTrades.filter(wouldBlock)
               : btFilter==='passed'  ? closedTrades.filter(t=>!wouldBlock(t)&&hasConv(t))
               : btFilter==='open'    ? openTrades
               : closedTrades

  // ── Shared style builders ──────────────────────────────────────────────────
  const pillBtn = (active, color=C.green) => ({
    padding:'6px 18px', borderRadius:20, cursor:'pointer',
    fontFamily:"'Inter', sans-serif", fontSize:12, fontWeight:600,
    letterSpacing:0.3, border:'none', transition:'all .15s',
    background: active ? color : C.cardAlt,
    color:       active ? (isDark?'#000':'#fff') : C.dim,
    boxShadow:   active ? shadow : 'none',
  })

  const sectionTab = (active) => ({
    padding:'9px 22px', borderRadius:8, cursor:'pointer',
    fontFamily:"'Inter', sans-serif", fontSize:13, fontWeight:600,
    border:`1px solid ${active ? C.green : C.border}`,
    background: active ? `${C.green}18` : 'transparent',
    color: active ? C.green : C.dim,
    transition:'all .15s',
  })

  const statCard = (color) => ({
    background: C.card,
    border: `1px solid ${C.border}`,
    borderTop: `3px solid ${color}`,
    borderRadius: 10,
    padding: '18px 20px',
    boxShadow: shadow,
    transition:'background .25s',
  })

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background:C.bg, minHeight:'100vh',
      fontFamily:"'Inter', 'IBM Plex Mono', sans-serif",
      color:C.text, paddingBottom:80,
      transition:'background .25s, color .25s',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box}
        input:focus,select:focus,textarea:focus{
          outline:none!important;
          border-color:${C.green}!important;
          box-shadow:0 0 0 3px ${C.green}22!important;
        }
        select option{background:${C.inputBg};color:${C.text}}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px}
        .tl-row:hover{background:${C.cardAlt}!important;transition:background .1s}
        .tl-btn:hover{opacity:.8;transition:opacity .15s}
        .tl-btn{cursor:pointer;transition:all .15s}
        @keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
        /* ── Stat tile mobile layout — real phone screenshot (2026-06-29)
            showed these as tall, mostly-empty cards: a single number sitting
            inside the same 18-20px padding tuned for a multi-column desktop
            grid. At real phone content widths, minmax(180px,1fr) forces
            exactly one column, so that padding (fine around a 180px-wide
            tile) reads as a lot of dead space around a full-width one.
            Rather than touch the grid threshold (it's fine at tablet/small-
            desktop widths), switch each tile's INTERNAL layout below 480px:
            label+value side-by-side in a slim row instead of stacked
            vertically, tighter padding, smaller value text — same
            information, far less wasted height, so the actual trade list
            below isn't pushed off the first screen by five tall stat cards. */
        @media(max-width:480px){
          .tl-stat-card{padding:10px 14px!important;display:flex!important;align-items:center!important;justify-content:space-between!important}
          .tl-stat-label{margin-bottom:0!important;font-size:11px!important}
          .tl-stat-value{font-size:20px!important}
          .tl-perf-grid{grid-template-columns:repeat(2,1fr)!important}
        }
        .slide-down{animation:slideDown .2s ease}
      `}</style>

      <AppNav
        isDark={isDark} setIsDark={setIsDark} C={C}
        {...props}
        tab="trades"
        setTab={(id) => navigate(`/app?tab=${id}`)}
      />

      <div style={{maxWidth:'min(92vw,1440px)', margin:'0 auto', padding:'28px 24px'}}>

        {/* ── Page header ── */}
        <div style={{marginBottom:28}}>
          <h1 style={{
            fontFamily:"'Fraunces',serif",
            fontSize:36, letterSpacing:0.3, color:C.green,
            margin:0, lineHeight:1,
          }}>TRADE LOG</h1>
          <p style={{
            fontSize:13, color:C.dim, marginTop:6,
            fontFamily:"'Inter', sans-serif",
          }}>
            {trades.length} trades &nbsp;·&nbsp; {openTrades.length} open &nbsp;·&nbsp; {closedTrades.length} closed
          </p>
        </div>

        {/* ── Stat cards ── */}
        <div style={{
          display:'grid',
          gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))',
          gap:12, marginBottom:28,
        }}>
          {[
            { label:'Open Positions', value:openTrades.length,  color:C.blue },
            { label:'Closed Trades',  value:closedTrades.length, color:C.dim  },
            {
              label:'Total P&L',
              value: closedTrades.length ? fmtUSD(totalPnl) : '—',
              color: totalPnl >= 0 ? C.green : C.red,
            },
            {
              label:'Win Rate',
              value: winRate !== null ? `${winRate}%` : '—',
              color: winRate === null ? C.dim : winRate>=50 ? C.green : C.red,
            },
            {
              // Streak — only shown once there's at least one eligible
              // closed trade; '—' rather than '0' for the zero-trades case,
              // same "don't fabricate a number from nothing" rule as every
              // other stat here.
              label:'Streak',
              value: streakType ? `${streakCount}${streakType==='win'?'W':'L'}` : '—',
              color: streakType === null ? C.dim : streakType==='win' ? C.green : C.red,
            },
          ].map(s => (
            <div key={s.label} className="tl-stat-card" style={statCard(s.color)}>
              <div className="tl-stat-label" style={{
                fontSize:11, color:C.dim, letterSpacing:0.8, marginBottom:10,
                fontFamily:"'Inter', sans-serif", fontWeight:600,
                textTransform:'uppercase',
              }}>{s.label}</div>
              <div className="tl-stat-value" style={{
                fontFamily:"'Fraunces',serif",
                fontSize:30, color:s.color, letterSpacing:0.3, lineHeight:1,
              }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ── This week vs last week — only renders once at least ONE of
            the two weeks has an eligible closed trade; both weeks empty
            (a user who hasn't closed anything yet) shows nothing at all
            rather than a hollow "— vs —" comparison with no information
            in it. */}
        {(thisWeekWinRate !== null || lastWeekWinRate !== null) && (
          <div style={{
            fontSize:12, color:C.dim, marginTop:-16, marginBottom:24,
            fontFamily:"'Inter', sans-serif",
          }}>
            This week: <strong style={{color:thisWeekWinRate===null?C.dim:thisWeekWinRate>=50?C.green:C.red}}>
              {thisWeekWinRate !== null ? `${thisWeekWinRate}%` : 'no closes yet'}
            </strong>
            {' '}vs last week:{' '}
            <strong style={{color:lastWeekWinRate===null?C.dim:lastWeekWinRate>=50?C.green:C.red}}>
              {lastWeekWinRate !== null ? `${lastWeekWinRate}%` : 'no closes'}
            </strong>
          </div>
        )}

        {/* ── Section tabs ── */}
        <div style={{display:'flex', gap:8, marginBottom:24}}>
          <button style={sectionTab(section==='log')}     onClick={()=>setSection('log')}>
            📋 TRADE LOG
          </button>
          <button style={sectionTab(section==='backtest')} onClick={()=>setSection('backtest')}>
            📊 PERFORMANCE
          </button>
        </div>

        {/* ════════════ TRADE LOG SECTION ════════════ */}
        {section==='log' && (
          <div className="slide-down">

            {/* Pending close suggestions — suggest-only per session design:
                a trade hitting target/stop never auto-closes. Shown
                immediately on page load (loadSuggestions runs alongside
                loadTrades), not buried per-row, since these are
                time-sensitive prompts the user should see right away. */}
            {suggestions.length > 0 && (
              <div style={{marginBottom:16,display:'flex',flexDirection:'column',gap:8}}>
                {suggestions.map(s => {
                  const t = s.trades || {}
                  const isTarget = s.reason === 'hit_target'
                  return (
                    <div key={s.id} style={{
                      background:isTarget?`${C.green}10`:`${C.red}10`,
                      border:`1px solid ${isTarget?C.green:C.red}40`,
                      borderRadius:8,padding:'10px 14px',
                      display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',
                    }}>
                      <span style={{fontSize:16}}>{isTarget ? '🎯' : '🛑'}</span>
                      <span style={{fontSize:13,color:C.text,flex:1}}>
                        <strong style={{color:C.blue}}>{t.ticker}</strong> {isTarget ? 'hit target' : 'hit stop'} at{' '}
                        <strong>${parseFloat(s.trigger_mid).toFixed(2)}</strong>
                        {' — '}mark this trade as closed?
                      </span>
                      <button
                        disabled={suggestionActionLoading===s.id}
                        onClick={()=>actOnSuggestion(s.id,'confirm')}
                        style={{
                          background:C.green,border:'none',color:C.bg,fontWeight:700,
                          padding:'6px 14px',borderRadius:6,fontSize:12,cursor:'pointer',
                          opacity:suggestionActionLoading===s.id?0.6:1,
                        }}
                      >
                        {suggestionActionLoading===s.id ? '…' : 'Confirm close'}
                      </button>
                      <button
                        disabled={suggestionActionLoading===s.id}
                        onClick={()=>actOnSuggestion(s.id,'dismiss')}
                        style={{
                          background:'transparent',border:`1px solid ${C.border}`,color:C.dim,
                          padding:'6px 14px',borderRadius:6,fontSize:12,cursor:'pointer',
                          opacity:suggestionActionLoading===s.id?0.6:1,
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Toolbar */}
            <div style={{
              display:'flex', alignItems:'center',
              justifyContent:'space-between',
              marginBottom:16, flexWrap:'wrap', gap:10,
            }}>
              <div style={{display:'flex', gap:6}}>
                {[
                  { id:'open',   label:'OPEN',   count:openTrades.length   },
                  { id:'closed', label:'CLOSED', count:closedTrades.length },
                  { id:'all',    label:'ALL',    count:trades.length       },
                ].map(f => (
                  <button key={f.id}
                    style={pillBtn(filter===f.id)}
                    onClick={()=>setFilter(f.id)}
                  >
                    {f.label} ({f.count})
                  </button>
                ))}
              </div>
              <button className="tl-btn" onClick={()=>{setShowAdd(p=>!p);setFormError(null)}}
                style={{
                  background: showAdd ? C.cardAlt : C.green,
                  color: showAdd ? C.dim : '#000',
                  border: `1px solid ${showAdd ? C.border : C.green}`,
                  borderRadius:8, padding:'9px 20px',
                  fontSize:13, fontWeight:700,
                  fontFamily:"'Inter', sans-serif",
                  boxShadow: showAdd ? 'none' : shadow,
                }}>
                {showAdd ? '✕  CANCEL' : '+ LOG TRADE'}
              </button>
            </div>

            {/* ── Add trade form ── */}
            {showAdd && (
              <div className="slide-down" style={{
                background:C.card,
                border:`1px solid ${C.green}40`,
                borderLeft:`3px solid ${C.green}`,
                borderRadius:10, padding:'24px',
                marginBottom:20, boxShadow:shadowMd,
              }}>
                <div style={{
                  fontSize:12, color:C.green, letterSpacing:2,
                  marginBottom:20, fontWeight:700,
                  fontFamily:"'Inter', sans-serif",
                }}>NEW TRADE</div>

                <div style={{
                  display:'grid',
                  gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))',
                  gap:14,
                }}>
                  {[
                    { label:'SYMBOL',    key:'symbol',      placeholder:'SPY',  type:'text'   },
                    { label:'STRIKE',    key:'strike',      placeholder:'500',  type:'number' },
                    { label:'CONTRACTS', key:'contracts',   placeholder:'1',    type:'number' },
                    { label:'PREMIUM',   key:'entry_price', placeholder:'2.50', type:'number', step:'0.01' },
                  ].map(f => (
                    <div key={f.key}>
                      <label style={{
                        display:'block', fontSize:11, fontWeight:600,
                        color:C.dim, letterSpacing:0.5, marginBottom:6,
                        fontFamily:"'Inter', sans-serif", textTransform:'uppercase',
                      }}>{f.label}</label>
                      <input style={iSt} type={f.type} step={f.step}
                        placeholder={f.placeholder}
                        value={form[f.key]}
                        onChange={e=>setForm(p=>({
                          ...p,
                          [f.key]: f.key==='symbol' ? e.target.value.toUpperCase() : e.target.value,
                        }))}
                      />
                    </div>
                  ))}

                  <div>
                    <label style={{display:'block',fontSize:11,fontWeight:600,color:C.dim,letterSpacing:0.5,marginBottom:6,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>TYPE</label>
                    <select style={iSt} value={form.option_type}
                      onChange={e=>setForm(p=>({...p,option_type:e.target.value}))}>
                      <option value="call">CALL</option>
                      <option value="put">PUT</option>
                    </select>
                  </div>

                  <div>
                    <label style={{display:'block',fontSize:11,fontWeight:600,color:C.dim,letterSpacing:0.5,marginBottom:6,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>ACTION</label>
                    <select style={iSt} value={form.action}
                      onChange={e=>setForm(p=>({...p,action:e.target.value}))}>
                      <option value="buy">BUY</option>
                      <option value="sell">SELL</option>
                    </select>
                  </div>

                  <div style={{gridColumn:'span 2'}}>
                    <label style={{display:'block',fontSize:11,fontWeight:600,color:C.dim,letterSpacing:0.5,marginBottom:6,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>EXPIRATION</label>
                    <input style={iSt} type="date" value={form.expiration}
                      onChange={e=>setForm(p=>({...p,expiration:e.target.value}))}/>
                  </div>
                </div>

                <div style={{marginTop:14}}>
                  <label style={{display:'block',fontSize:11,fontWeight:600,color:C.dim,letterSpacing:0.5,marginBottom:6,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>NOTES (OPTIONAL)</label>
                  <input style={iSt} placeholder="e.g. high edge score, earnings play…"
                    value={form.notes}
                    onChange={e=>setForm(p=>({...p,notes:e.target.value}))}/>
                </div>

                {formError && (
                  <div style={{
                    color:C.red, fontSize:12, marginTop:12,
                    padding:'10px 14px', background:`${C.red}12`,
                    borderRadius:6, border:`1px solid ${C.red}30`,
                    lineHeight:1.5,
                  }}>
                    ⚠ {formError}
                    {(formError.includes('Session') || formError.includes('401') || formError.includes('token')) && (
                      <div style={{marginTop:6, fontSize:11, color:C.orange}}>
                        Your session may have expired. Please <span style={{textDecoration:'underline',cursor:'pointer'}} onClick={()=>window.location.reload()}>refresh the page</span> and sign in again.
                      </div>
                    )}
                  </div>
                )}

                <div style={{marginTop:18, display:'flex', gap:10}}>
                  <button className="tl-btn" onClick={handleAdd} disabled={submitting} style={{
                    background:C.green, color:'#000', border:'none',
                    borderRadius:8, padding:'10px 24px',
                    fontSize:13, fontWeight:700,
                    fontFamily:"'Inter', sans-serif",
                    opacity:submitting?0.6:1,
                    boxShadow:shadow,
                  }}>
                    {submitting ? 'SAVING…' : 'SAVE TRADE'}
                  </button>
                  <button className="tl-btn" onClick={()=>setShowAdd(false)} style={{
                    background:'transparent', border:`1px solid ${C.border}`,
                    color:C.dim, borderRadius:8, padding:'10px 18px',
                    fontSize:13, fontFamily:"'Inter', sans-serif",
                  }}>CANCEL</button>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{
                background:`${C.red}12`, border:`1px solid ${C.red}30`,
                borderRadius:8, padding:'12px 16px',
                color:C.red, fontSize:13, marginBottom:16,
              }}>⚠ {error}</div>
            )}

            {/* Loading */}
            {loading && (
              <div style={{textAlign:'center', padding:48, color:C.dim, fontSize:13}}>
                Loading trades…
              </div>
            )}

            {/* Empty state */}
            {!loading && displayed.length===0 && (
              <div style={{
                background:C.card, border:`1px solid ${C.border}`,
                borderRadius:10, padding:'48px 24px',
                textAlign:'center', boxShadow:shadow,
              }}>
                <div style={{fontSize:32, marginBottom:12}}>
                  {filter==='open' ? '📭' : '📋'}
                </div>
                <div style={{fontSize:15, color:C.text, fontWeight:600, marginBottom:6, fontFamily:"'Inter',sans-serif"}}>
                  {filter==='open' ? 'No open positions' : filter==='closed' ? 'No closed trades yet' : 'No trades logged yet'}
                </div>
                <div style={{fontSize:13, color:C.dim, fontFamily:"'Inter',sans-serif"}}>
                  {filter==='open' && 'Click + LOG TRADE above to add your first position'}
                </div>
              </div>
            )}

            {/* ── Trade table ── */}
            {!loading && displayed.length>0 && (
              <div style={{
                background:C.card, border:`1px solid ${C.border}`,
                borderRadius:10, overflow:'hidden', boxShadow:shadow,
              }}>
              {/* Horizontal scroll wrapper — table is 750px+ of fixed columns;
                  below that viewport width, scroll instead of clipping P&L/Exit. */}
              <div style={{overflowX:'auto'}}>
                {/* Header */}
                <div style={{
                  display:'grid',
                  gridTemplateColumns:'90px 55px 50px 70px 100px 45px 75px 75px 80px 110px',
                  minWidth:790,
                  padding:'12px 20px',
                  background:C.bgAlt,
                  borderBottom:`1px solid ${C.border}`,
                  fontSize:11, color:C.dim, fontWeight:600,
                  fontFamily:"'Inter', sans-serif",
                  letterSpacing:0.5, textTransform:'uppercase',
                }}>
                  {['Symbol','Type','Side','Strike','Exp','Qty','Entry','Exit','P&L',''].map((h,i)=>(
                    <span key={i} style={{textAlign:i===9?'right':'left'}}>{h}</span>
                  ))}
                </div>

                {/* Rows */}
                {displayed.map((trade, i) => {
                  const isClosed  = (trade.status??'').toLowerCase()==='closed' || !!trade.exit_price
                  const isClosing = closingId===trade.id
                  const pnl       = calcPnl(trade)
                  const rMultiple = calcR(trade)
                  const pnlColor  = pnl===null ? C.dim : pnl>=0 ? C.green : C.red
                  const leftBorder= isClosed
                    ? `3px solid ${pnl!==null && pnl>=0 ? C.green : C.red}`
                    : `3px solid ${C.blue}`

                  return (
                    <div key={trade.id}>
                      <div className="tl-row" style={{
                        display:'grid',
                        gridTemplateColumns:'90px 55px 50px 70px 100px 45px 75px 75px 80px 110px',
                        minWidth:790,
                        padding:'14px 20px',
                        borderLeft: leftBorder,
                        borderBottom:`1px solid ${C.border}30`,
                        alignItems:'center',
                        opacity: isClosed ? 0.7 : 1,
                        background: i%2===0 ? 'transparent' : C.cardAlt,
                      }}>
                        <span style={{display:'flex', alignItems:'center', gap:6}}>
                          <span style={{
                            color:C.blue, fontWeight:700, fontSize:14,
                            fontFamily:"'IBM Plex Mono', monospace",
                          }}>{trade.ticker}</span>
                          {/* Verdict badge — only shown for trades that have
                              actually been checked (last_verdict_check_at
                              not null). A trade missing timeframe/target/
                              stop, or one that predates this feature, shows
                              NOTHING here rather than a misleading "fine"
                              dot — silence is the honest state for "not
                              monitored," per the session decision not to
                              guess/default for unscored trades. */}
                          {!isClosed && trade.last_verdict_check_at && (
                            <button
                              onClick={()=>toggleVerdictHistory(trade.id)}
                              title={trade.flagged ? 'Flagged — click for history' : 'Looking fine — click for history'}
                              style={{
                                width:8, height:8, borderRadius:'50%', border:'none', padding:0,
                                cursor:'pointer', flexShrink:0,
                                background: trade.flagged ? C.orange : C.green,
                              }}
                            />
                          )}
                        </span>

                        <span style={{
                          fontSize:11, fontWeight:600, textTransform:'uppercase',
                          color:(trade.option_type??trade.type??"").toLowerCase()==='call' ? C.green : C.orange,
                          fontFamily:"'Inter', sans-serif",
                        }}>
                          {(trade.option_type??trade.type??"").slice(0,4)}
                        </span>

                        <span style={{
                          fontSize:11, fontWeight:600, textTransform:'uppercase',
                          color:(trade.action??'buy').toLowerCase()==='buy' ? C.green : C.red,
                          fontFamily:"'Inter', sans-serif",
                        }}>
                          {(trade.action??'buy').toUpperCase()}
                        </span>

                        <span style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:12}}>
                          ${fmt(trade.strike,0)}
                        </span>

                        <span style={{color:C.dim, fontSize:11, fontFamily:"'Inter',sans-serif"}}>
                          {fmtExpiry(trade.expiration??trade.expiry)}
                        </span>

                        <span style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:12}}>
                          {trade.contracts??1}
                        </span>

                        <span style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:12}}>
                          ${fmt(trade.entry_price??trade.entry)}
                        </span>

                        <span style={{
                          fontFamily:"'IBM Plex Mono',monospace", fontSize:12,
                          color: isClosed ? C.text : C.dim,
                        }}>
                          {isClosed ? `$${fmt(trade.exit_price??trade.exitPrice)}` : '—'}
                        </span>

                        <span style={{
                          fontFamily:"'Fraunces',serif",
                          fontSize:16, color:pnlColor, letterSpacing:0.5,
                        }}>
                          {pnl!==null
                            ? <>{`${pnl>=0?'+':'-'}$${Math.abs(pnl).toFixed(0)}`}<small style={{display:'block',fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:pnlColor,marginTop:2}}>{rMultiple===null?'R unavailable':`${rMultiple>=0?'+':''}${rMultiple.toFixed(2)}R`}</small></>
                            : <span style={{fontSize:12, color:C.dim}}>—</span>
                          }
                        </span>

                        <div style={{display:'flex', gap:6, justifyContent:'flex-end'}}>
                          {!isClosed && (
                            <button className="tl-btn" onClick={()=>{
                              setClosingId(isClosing?null:trade.id)
                              setCloseForm(EMPTY_CLOSE); setCloseError(null)
                            }} style={{
                              background:`${C.orange}15`, color:C.orange,
                              border:`1px solid ${C.orange}40`, borderRadius:6,
                              padding:'5px 12px', fontSize:11, fontWeight:600,
                              fontFamily:"'Inter',sans-serif",
                            }}>
                              {isClosing ? 'CANCEL' : 'CLOSE'}
                            </button>
                          )}
                          <button className="tl-btn" onClick={()=>handleDelete(trade.id)}
                            disabled={deletingId===trade.id}
                            style={{
                              background:`${C.red}10`, color:C.red,
                              border:`1px solid ${C.red}30`, borderRadius:6,
                              padding:'5px 9px', fontSize:12,
                              opacity:deletingId===trade.id?0.5:1,
                            }}>✕</button>
                        </div>
                      </div>
                      <div style={{minWidth:790,padding:'7px 20px 9px 23px',display:'flex',alignItems:'center',gap:8,borderBottom:`1px solid ${C.border}30`,background:i%2===0?'transparent':C.cardAlt}}>
                        {[
                          ['LOGGED',true],
                          ['MONITORED',!!trade.last_verdict_check_at||isClosed],
                          ['RESOLVED',isClosed],
                        ].map(([label,complete],step)=><div key={label} style={{display:'flex',alignItems:'center',gap:6,flex:step<2?1:0}}>
                          <span style={{width:8,height:8,borderRadius:'50%',background:complete?C.green:C.border,flexShrink:0}}/>
                          <span style={{fontSize:10,fontWeight:700,color:complete?C.green:C.dim,letterSpacing:.5}}>{label}</span>
                          {step<2&&<span style={{height:1,background:complete?`${C.green}60`:C.border,flex:1}}/>}
                        </div>)}
                      </div>

                      {/* Inline close form */}
                      {isClosing && (
                        <div className="slide-down" style={{
                          background:`${C.orange}08`,
                          borderLeft:`3px solid ${C.orange}`,
                          borderBottom:`1px solid ${C.orange}20`,
                          padding:'16px 20px',
                          display:'flex', alignItems:'flex-end',
                          gap:16, flexWrap:'wrap',
                        }}>
                          <div>
                            <label style={{
                              display:'block', fontSize:11, fontWeight:600,
                              color:C.orange, letterSpacing:0.5, marginBottom:6,
                              fontFamily:"'Inter',sans-serif", textTransform:'uppercase',
                            }}>EXIT PRICE / CONTRACT</label>
                            <input autoFocus
                              style={{...iSt, width:160, border:`1px solid ${C.orange}50`}}
                              type="number" step="0.01" placeholder="e.g. 4.20"
                              value={closeForm.exit_price}
                              onChange={e=>setCloseForm({exit_price:e.target.value})}
                            />
                          </div>
                          {closeForm.exit_price && (() => {
                            const p = calcPnl({...trade, exit_price:parseFloat(closeForm.exit_price)})
                            return p!==null ? (
                              <div style={{paddingBottom:6}}>
                                <div style={{fontSize:11,color:C.dim,marginBottom:2,fontFamily:"'Inter',sans-serif"}}>EST. P&L</div>
                                <div style={{
                                  fontFamily:"'Fraunces',serif",
                                  fontSize:24, color:p>=0?C.green:C.red, letterSpacing:0.3,
                                }}>
                                  {p>=0?'+':'-'}${Math.abs(p).toFixed(0)}
                                </div>
                              </div>
                            ) : null
                          })()}
                          {closeError && (
                            <div style={{color:C.red, fontSize:12}}>{closeError}</div>
                          )}
                          <button className="tl-btn" onClick={()=>handleClose(trade.id)}
                            disabled={submitting} style={{
                              background:C.orange, color:'#000', border:'none',
                              borderRadius:8, padding:'10px 20px',
                              fontSize:13, fontWeight:700,
                              fontFamily:"'Inter',sans-serif",
                              opacity:submitting?0.6:1,
                              marginBottom:0, boxShadow:shadow,
                            }}>
                            {submitting ? 'SAVING…' : 'CONFIRM CLOSE'}
                          </button>
                        </div>
                      )}

                      {/* Verdict history — mirrors the inline close-form
                          pattern above (slide-down, conditional render),
                          not a new mechanism. */}
                      {expandedVerdictId === trade.id && (
                        <div className="slide-down" style={{
                          background:`${C.blue}08`,
                          borderLeft:`3px solid ${C.blue}`,
                          borderBottom:`1px solid ${C.blue}20`,
                          padding:'12px 20px',
                        }}>
                          {verdictHistoryLoading === trade.id ? (
                            <div style={{fontSize:12, color:C.dim}}>Loading…</div>
                          ) : (verdictHistory[trade.id]?.length ?? 0) === 0 ? (
                            <div style={{fontSize:12, color:C.dim}}>
                              No flag changes yet — last checked{' '}
                              {new Date(trade.last_verdict_check_at).toLocaleString('en-US', {
                                month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
                              })}
                              , currently {trade.flagged ? 'flagged' : 'looking fine'}
                              {trade.current_score != null && ` (score ${trade.current_score})`}.
                            </div>
                          ) : (
                            <div style={{display:'flex', flexDirection:'column', gap:6}}>
                              {verdictHistory[trade.id].map((h, idx) => (
                                <div key={idx} style={{fontSize:12, color:C.dim, display:'flex', gap:10, alignItems:'baseline'}}>
                                  <span style={{
                                    width:8, height:8, borderRadius:'50%', flexShrink:0,
                                    background: h.flagged ? C.orange : C.green,
                                  }}/>
                                  <span>
                                    {new Date(h.checked_at).toLocaleString('en-US', {
                                      month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
                                    })}
                                    {' — '}
                                    {h.flagged
                                      ? `flagged (score ${h.current_score}, was ${h.entry_score} at entry${(h.flag_reasons||[]).length ? ', ' + h.flag_reasons.join(', ') : ''})`
                                      : `cleared (score ${h.current_score})`}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Notes row */}
                      {trade.notes && (
                        <div style={{
                          padding:'6px 20px 10px',
                          fontSize:12, color:C.dim,
                          fontStyle:'italic',
                          borderBottom:`1px solid ${C.border}20`,
                          background: i%2===0 ? 'transparent' : C.cardAlt,
                        }}>
                          ↳ {trade.notes}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              </div>
            )}

            {/* Win/loss summary — WIN RATE and TOTAL P&L intentionally omitted
                here since they're already shown in the fixed page header
                above; this row exists to surface the win/loss split that
                the header doesn't break out. */}
            {closedTrades.length>0 && (
              <div style={{
                display:'grid',
                gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))',
                gap:10, marginTop:16,
              }}>
                {[
                  { label:'WINS',      value:wins.length,   color:C.green },
                  { label:'LOSSES',    value:losses.length, color:C.red   },
                ].map(s => (
                  <div key={s.label} style={{
                    background:C.card, border:`1px solid ${C.border}`,
                    borderRadius:8, padding:'12px 16px',
                    boxShadow:shadow,
                  }}>
                    <div style={{fontSize:10,color:C.dim,fontWeight:600,letterSpacing:0.5,marginBottom:6,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>{s.label}</div>
                    <div style={{fontFamily:"'Fraunces',serif",fontSize:22,color:s.color,letterSpacing:0.5}}>{s.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════ BACKTEST SECTION ════════════ */}
        {section==='backtest' && (
          <div className="slide-down">
            {closedTrades.length===0 ? (
              <div style={{
                background:C.card, border:`1px solid ${C.border}`,
                borderRadius:10, padding:'48px 24px',
                textAlign:'center', boxShadow:shadow,
              }}>
                <div style={{fontSize:32, marginBottom:12}}>📊</div>
                <div style={{fontSize:15, color:C.text, fontWeight:600, marginBottom:8, fontFamily:"'Inter',sans-serif"}}>No closed trades to analyze</div>
                <div style={{fontSize:13, color:C.dim, lineHeight:1.8, fontFamily:"'Inter',sans-serif"}}>
                  Close trades in the Trade Log tab to see analytics here.
                </div>
              </div>
            ) : (
              <>
                {/* Summary stats */}
                <div className="tl-perf-grid" style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginBottom:20}}>
                  {[
                    { label:'TOTAL P&L',   value:fmtUSD(totPL(closedTrades)), color:totPL(closedTrades)>=0?C.green:C.red },
                    { label:'WIN RATE',    value:(wr(closedTrades)??0)+'%',    color:(wr(closedTrades)??0)>=60?C.green:(wr(closedTrades)??0)>=45?C.orange:C.red },
                    { label:'EXPECTANCY',  value:fmtUSD(expectancy)+'/trade',  color:expectancy>=0?C.green:C.red },
                    { label:'AVG WIN',     value:wins.length?'+$'+avgWin.toFixed(0):'—', color:C.green },
                    { label:'AVG LOSS',    value:losses.length?'-$'+avgLoss.toFixed(0):'—', color:C.red },
                    { label:'W / L',       value:`${wins.length}W / ${losses.length}L`, color:C.dim },
                  ].map((s,i) => (
                    <div key={i} className="tl-stat-card" style={statCard(s.color)}>
                      <div className="tl-stat-label" style={{fontSize:11,color:C.dim,fontWeight:600,letterSpacing:0.5,marginBottom:8,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>{s.label}</div>
                      <div className="tl-stat-value" style={{fontFamily:"'Fraunces',serif",fontSize:24,color:s.color,letterSpacing:0.5}}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {/* Equity curve */}
                <div style={{
                  background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:10, padding:'20px 24px',
                  marginBottom:16, boxShadow:shadow,
                }}>
                  <div style={{fontSize:11,color:C.dim,fontWeight:600,letterSpacing:0.5,marginBottom:14,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>EQUITY CURVE</div>
                  <EquityCurve trades={closedTrades} C={C}/>
                </div>

                {/* Filter impact */}
                {(blocked.length>0||passed.length>0) && (
                  <div style={{
                    background:C.card, border:`1px solid ${C.border}`,
                    borderRadius:10, padding:'20px 24px',
                    marginBottom:16, boxShadow:shadow,
                  }}>
                    <div style={{fontSize:11,color:C.dim,fontWeight:600,letterSpacing:0.5,marginBottom:16,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>FILTER IMPACT ANALYSIS</div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                      {[
                        { label:'WOULD BLOCK', arr:blocked, color:C.red,   icon:'🚫', sign:-1 },
                        { label:'PASSES FILTERS', arr:passed, color:C.green, icon:'✅', sign:1  },
                      ].map(b => (
                        <div key={b.label} style={{
                          background:C.cardAlt,
                          border:`1px solid ${b.color}30`,
                          borderLeft:`3px solid ${b.color}`,
                          borderRadius:8, padding:'16px',
                        }}>
                          <div style={{fontSize:11,color:b.color,fontWeight:700,letterSpacing:0.5,marginBottom:10,fontFamily:"'Inter',sans-serif"}}>{b.icon} {b.label}</div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:32,color:b.color,marginBottom:4}}>{b.arr.length}</div>
                          <div style={{fontSize:12,color:C.dim,fontFamily:"'Inter',sans-serif",marginBottom:6}}>trades</div>
                          {wr(b.arr)!==null && <div style={{fontSize:13,color:b.color,fontWeight:600,fontFamily:"'Inter',sans-serif"}}>Win rate: {wr(b.arr)}%</div>}
                          <div style={{fontSize:12,color:C.dim,fontFamily:"'Inter',sans-serif",marginTop:4}}>
                            P&L: <span style={{color:totPL(b.arr)*b.sign>=0?C.green:C.red,fontWeight:600}}>${Math.abs(totPL(b.arr)).toFixed(0)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Conviction bands */}
                {(hi90.length>0||hi70.length>0||lo70.length>0) && (
                  <div style={{
                    background:C.card, border:`1px solid ${C.border}`,
                    borderRadius:10, padding:'20px 24px',
                    marginBottom:16, boxShadow:shadow,
                  }}>
                    <div style={{fontSize:11,color:C.dim,fontWeight:600,letterSpacing:0.5,marginBottom:16,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>WIN RATE BY CONVICTION BAND</div>
                    {[
                      { label:'90%+  HIGH CONVICTION', arr:hi90, color:C.green  },
                      { label:'70–89%  MODERATE',       arr:hi70, color:C.orange },
                      { label:'< 70%  LOW',             arr:lo70, color:C.red    },
                    ].filter(b=>b.arr.length>0).map((b,i) => {
                      const bWr = wr(b.arr)??0
                      const w   = b.arr.filter(t=>pnlOf(t)>0).length
                      return (
                        <div key={i} style={{
                          display:'flex', alignItems:'center', gap:14,
                          padding:'12px 14px', borderRadius:8, marginBottom:8,
                          background:C.cardAlt, border:`1px solid ${b.color}25`,
                        }}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,color:b.color,fontWeight:600,marginBottom:4,fontFamily:"'Inter',sans-serif"}}>{b.label}</div>
                            <div style={{fontSize:12,color:C.dim,fontFamily:"'Inter',sans-serif"}}>{b.arr.length} trades · {w}W / {b.arr.length-w}L · <span style={{color:totPL(b.arr)>=0?C.green:C.red,fontWeight:600}}>${Math.abs(totPL(b.arr)).toFixed(0)}</span></div>
                            <div style={{marginTop:8,height:6,background:C.border,borderRadius:3,overflow:'hidden'}}>
                              <div style={{width:bWr+'%',height:'100%',background:b.color,borderRadius:3,transition:'width .4s'}}/>
                            </div>
                          </div>
                          <div style={{textAlign:'right',flexShrink:0}}>
                            <div style={{fontFamily:"'Fraunces',serif",fontSize:30,color:bWr>=60?C.green:bWr>=45?C.orange:C.red,lineHeight:1}}>{bWr}%</div>
                            <div style={{fontSize:10,color:C.dim,fontFamily:"'Inter',sans-serif"}}>win rate</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* IV analysis */}
                {closedTrades.filter(t=>ivOf(t)>0).length>=2 && (
                  <div style={{
                    background:C.card, border:`1px solid ${C.border}`,
                    borderRadius:10, padding:'20px 24px',
                    marginBottom:16, boxShadow:shadow,
                  }}>
                    <div style={{fontSize:11,color:C.dim,fontWeight:600,letterSpacing:0.5,marginBottom:16,fontFamily:"'Inter',sans-serif",textTransform:'uppercase'}}>OUTCOME BY IV AT ENTRY</div>
                    {[
                      { label:'Low IV  (< 40%)',     arr:closedTrades.filter(t=>ivOf(t)>0&&ivOf(t)<40),   color:C.green  },
                      { label:'Moderate  (40–55%)',  arr:closedTrades.filter(t=>ivOf(t)>=40&&ivOf(t)<=55), color:C.orange },
                      { label:'High IV  (> 55%)',    arr:closedTrades.filter(t=>ivOf(t)>55),              color:C.red    },
                    ].filter(b=>b.arr.length>0).map((b,i) => {
                      const bWr=wr(b.arr)??0, w=b.arr.filter(t=>pnlOf(t)>0).length
                      return (
                        <div key={i} style={{
                          display:'flex', alignItems:'center', gap:14,
                          padding:'12px 14px', borderRadius:8, marginBottom:8,
                          background:C.cardAlt, border:`1px solid ${b.color}25`,
                        }}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,color:b.color,fontWeight:600,marginBottom:4,fontFamily:"'Inter',sans-serif"}}>{b.label}</div>
                            <div style={{fontSize:12,color:C.dim,fontFamily:"'Inter',sans-serif"}}>{b.arr.length} trades · {w}W / {b.arr.length-w}L · <span style={{color:totPL(b.arr)>=0?C.green:C.red,fontWeight:600}}>${Math.abs(totPL(b.arr)).toFixed(0)}</span></div>
                          </div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:28,color:bWr>=60?C.green:bWr>=45?C.orange:C.red}}>{bWr}%</div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Trade filter tabs + list */}
                <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:14}}>
                  {[
                    { id:'all',     label:'All Closed',   count:closedTrades.length },
                    { id:'90plus',  label:'90%+ Only',    count:closedTrades.filter(t=>convOf(t)>=90).length },
                    { id:'blocked', label:'Would Block',  count:blocked.length },
                    { id:'passed',  label:'Clean Setups', count:passed.length  },
                    { id:'open',    label:'Open / Paper', count:openTrades.length },
                  ].map(f => (
                    <button key={f.id} style={pillBtn(btFilter===f.id, C.blue)}
                      onClick={()=>setBtFilter(f.id)}>
                      {f.label} ({f.count})
                    </button>
                  ))}
                </div>

                {btList.length===0 ? (
                  <div style={{fontSize:13,color:C.dim,textAlign:'center',padding:20,border:`1px dashed ${C.border}`,borderRadius:8}}>No trades in this filter</div>
                ) : btList.map((t,i) => {
                  const p=pnlOf(t), isWin=p>0, isLoss=p<0
                  const stC=(t.status??'open').toLowerCase()==='open'?C.blue:isWin?C.green:isLoss?C.red:C.dim
                  const bl=wouldBlock(t)
                  return (
                    <div key={t.id??i} style={{
                      background:C.card, border:`1px solid ${C.border}`,
                      borderLeft:`3px solid ${stC}`, borderRadius:8,
                      padding:'12px 16px', marginBottom:8, boxShadow:shadow,
                      transition:'background .15s',
                    }}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:6}}>
                        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,color:C.text,fontWeight:700}}>{t.symbol??t.ticker}</span>
                          <span style={{fontSize:11,color:stC,border:`1px solid ${stC}40`,padding:'2px 7px',borderRadius:4,fontFamily:"'Inter',sans-serif",fontWeight:600}}>{(t.status??'OPEN').toUpperCase()}</span>
                          <span style={{fontSize:12,color:C.dim,fontFamily:"'Inter',sans-serif"}}>{t.option_type??t.type}</span>
                          {t.strike&&<span style={{fontSize:12,color:C.dim,fontFamily:"'IBM Plex Mono',monospace"}}>${fmt(t.strike,0)}</span>}
                          {(t.expiration??t.expiry)&&<span style={{fontSize:11,color:C.dim,fontFamily:"'Inter',sans-serif"}}>{t.expiration??t.expiry}</span>}
                          {t.conviction&&<span style={{fontSize:11,color:C.blue,border:`1px solid ${C.blue}30`,padding:'2px 6px',borderRadius:4,fontFamily:"'Inter',sans-serif",fontWeight:600}}>{t.conviction}%</span>}
                          {bl&&<span style={{fontSize:11,color:C.red,border:`1px solid ${C.red}30`,padding:'2px 6px',borderRadius:4,fontFamily:"'Inter',sans-serif"}}>🚫 BLOCKED</span>}
                        </div>
                        <div style={{display:'flex',gap:8,alignItems:'center'}}>
                          {p!==0&&<span style={{fontFamily:"'Fraunces',serif",fontSize:20,color:isWin?C.green:C.red}}>{p>=0?'+':'-'}${Math.abs(p).toFixed(0)}</span>}
                          {(t.status??'open').toLowerCase()==='open'&&<span style={{fontSize:11,color:C.orange,border:`1px solid ${C.orange}40`,padding:'2px 6px',borderRadius:4,fontFamily:"'Inter',sans-serif"}}>PAPER</span>}
                        </div>
                      </div>
                      <div style={{display:'flex',gap:14,marginTop:8,fontSize:12,color:C.dim,flexWrap:'wrap',fontFamily:"'Inter',sans-serif"}}>
                        {(t.entry_price??t.entry)&&<span>Entry: <span style={{color:C.subtext,fontFamily:"'IBM Plex Mono',monospace"}}>${fmt(t.entry_price??t.entry)}</span></span>}
                        {(t.exit_price??t.exitPrice)&&<span>Exit: <span style={{color:C.subtext,fontFamily:"'IBM Plex Mono',monospace"}}>${fmt(t.exit_price??t.exitPrice)}</span></span>}
                        {ivOf(t)>0&&<span>IV: <span style={{color:ivOf(t)>55?C.red:ivOf(t)>40?C.orange:C.green,fontWeight:600}}>{ivOf(t).toFixed(0)}%</span></span>}
                        {chgOf(t)!==0&&<span>Stk Δ: <span style={{color:Math.abs(chgOf(t))>2?C.red:C.subtext}}>{chgOf(t)>0?'+':''}{chgOf(t).toFixed(1)}%</span></span>}
                        {beOf(t)>0&&<span>BE req: <span style={{color:beOf(t)>5?C.red:beOf(t)>3?C.orange:C.green}}>+{beOf(t).toFixed(1)}%</span></span>}
                      </div>
                      {t.notes&&<div style={{marginTop:6,fontSize:12,color:C.dim,fontStyle:'italic',fontFamily:"'Inter',sans-serif"}}>{t.notes}</div>}
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
