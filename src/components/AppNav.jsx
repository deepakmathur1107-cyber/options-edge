/**
 * src/components/AppNav.jsx
 *
 * Responsive nav:
 *   Desktop ≥768px : sticky top bar
 *   Mobile  <768px : fixed bottom tab bar
 *
 * Design rules:
 *   - Active tab  : solid filled C.green, black text, green glow
 *   - Theme toggle: amber solid bg
 *   - Bell        : blue solid bg
 *   - SANDBOX/PROD: colored badge
 *   - PRO         : green badge
 *   - OUT         : red badge, solid fill
 */
import { Link, useLocation } from 'react-router-dom'

export default function AppNav({
  tab, setTab,
  isDark, C, setIsDark,
  userInitial, openPortal, onSignOut,
  isAdmin, tradierMode, autoOn,
  showTools, setShowTools,
}) {
  const location    = useLocation()
  // Trades used to be treated as a separate "sub-page" (Back-to-/app link
  // instead of the normal 5-tab bar) whenever location.pathname was
  // '/app/trades'. That's been removed — Trades is now a full peer tab,
  // consistent with Dash/Scan/Tools/Admin, on both desktop and mobile.
  const isTradesPage = location.pathname === '/app/trades'

  // ── Shared base ───────────────────────────────────────────────────────────
  const base = {
    cursor: 'pointer', transition: 'all .15s',
    fontFamily: "'Inter', sans-serif",
    border: 'none', outline: 'none',
  }

  // ── Desktop top-nav tab (active = solid green filled) ─────────────────────
  const topTab = (active) => ({
    ...base,
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '7px 18px', borderRadius: 7,
    fontWeight: 700, fontSize: 12, letterSpacing: 0.4,
    background: active ? C.green : 'transparent',
    // Deliberately a fixed dark value, not a theme token — this text sits on
    // the green active-tab fill (C.green), which is roughly the same
    // brightness in both themes. C.bg/C.text flip between near-white and
    // near-black by design, which would break contrast here in light mode.
    color:      active ? '#1c1916' : C.dim,
    border:     active ? 'none'  : `1px solid transparent`,
    boxShadow:  active ? `0 2px 10px ${C.green}55` : 'none',
  })

  // ── Icon pill (bell, theme toggle) ────────────────────────────────────────
  const iconPill = (bg, border, color) => ({
    ...base,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 36, height: 36, borderRadius: 8,
    background: bg, border: `1px solid ${border}`,
    color, fontSize: 17, fontWeight: 700,
    textDecoration: 'none',
  })

  // ── Small badge ───────────────────────────────────────────────────────────
  const badge = (bg, border, color) => ({
    ...base,
    padding: '4px 10px', borderRadius: 5,
    fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
    background: bg, border: `1px solid ${border}`,
    color,
  })

  // ── Mobile bottom tab button ──────────────────────────────────────────────
  const mobileTab = (active) => ({
    ...base,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 3,
    flex: 1, height: 58,
    background: 'transparent',
    borderTop: `3px solid ${active ? C.green : 'transparent'}`,
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  })

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        @keyframes navpulse{0%,100%{opacity:1}50%{opacity:.4}}
        @media(max-width:767px){.oe-top{display:none!important}}
        @media(min-width:768px){.oe-bot{display:none!important}}
        .oe-navbtn{cursor:pointer}
        .oe-navbtn:hover{opacity:.82!important}
        .oe-toptab:hover{border:1px solid ${C.green}60!important;color:${C.text}!important}
      `}</style>

      {/* ══════════════════════════════════════════════════════════════════════
          DESKTOP TOP NAV
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="oe-top" style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: C.bgAlt,
        borderBottom: `1px solid ${C.border}`,
        boxShadow: isDark
          ? '0 2px 12px rgba(0,0,0,.45)'
          : '0 2px 12px rgba(0,0,0,.08)',
      }}>
        <div style={{
          maxWidth: 1100, margin: '0 auto',
          padding: '0 20px', height: 58,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>

          {/* Logo */}
          <div style={{ display:'flex', alignItems:'baseline', gap:6, marginRight:14, flexShrink:0 }}>
            <span style={{
              fontFamily: "'Fraunces',serif",
              fontSize: 22, letterSpacing:0.3,
              color: C.green, lineHeight: 1,
            }}>OPTIONS EDGE</span>
            <span style={{ fontSize: 8, color: C.dim, letterSpacing: 2 }}>v3.0</span>
          </div>

          {/* ── Main app tabs — always shown, Trades included as a peer tab ── */}
          <div style={{ display:'flex', gap:4, flex:1 }}>
            {[
              { id:'dash',  icon:'◈', label:'DASH'  },
              { id:'scan',  icon:'⌁', label:'SCAN'  },
            ].map(t => (
              <button key={t.id} className="oe-navbtn oe-toptab"
                onClick={() => setTab(t.id)}
                style={topTab(tab === t.id)}
              >
                {t.icon}&nbsp;{t.label}
              </button>
            ))}

            <Link to="/app/trades" className="oe-navbtn oe-toptab"
              style={{ ...topTab(isTradesPage), textDecoration:'none' }}>
              ≡&nbsp;TRADES
            </Link>

            <button className="oe-navbtn oe-toptab"
              onClick={() => setShowTools(p => !p)}
              style={topTab(showTools)}>
              ⚙&nbsp;TOOLS
            </button>

            {isAdmin && (
              <button className="oe-navbtn oe-toptab"
                onClick={() => setTab('admin')}
                style={{...topTab(tab === 'admin'), color: tab === 'admin' ? '#1c1916' : C.green, borderColor: `${C.green}40`}}>
                ★&nbsp;ADMIN
              </button>
            )}
          </div>

          {/* ── Right controls ── */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginLeft:'auto', flexShrink:0 }}>

            {/* LIVE pulse */}
            {autoOn && (
              <span style={{ fontSize:9, color:C.green, display:'flex', alignItems:'center', gap:4 }}>
                <span style={{
                  width:7, height:7, borderRadius:'50%',
                  background: C.green, display:'inline-block',
                  boxShadow: `0 0 8px ${C.green}`,
                  animation: 'navpulse 1.1s infinite',
                }}/>
                LIVE
              </span>
            )}

            {/* Tradier mode badge — admin only */}
            {isAdmin && tradierMode && (
              <span style={{
                fontSize: 8, fontWeight: 700, letterSpacing: 1,
                padding: '5px 10px', borderRadius: 5,
                background: tradierMode === 'sandbox'
                  ? `${C.orange}25` : `${C.green}20`,
                border: `1px solid ${tradierMode === 'sandbox'
                  ? C.orange + '70' : C.green + '60'}`,
                color: tradierMode === 'sandbox' ? C.orange : C.green,
              }}>
                {tradierMode.toUpperCase()}
              </span>
            )}

            {/* Theme toggle — amber */}
            <button className="oe-navbtn"
              onClick={() => setIsDark(p => !p)}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              style={iconPill('#e8a84e28', '#e8a84e70', '#e8a84e')}>
              {isDark ? '☀' : '🌙'}
            </button>

            {/* User avatar + badges */}
            {userInitial && (
              <>
                <div style={{
                  width: 34, height: 34, borderRadius: '50%',
                  background: `${C.green}25`,
                  border: `2px solid ${C.green}60`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, color: C.green, fontWeight: 700,
                  flexShrink: 0,
                }}>
                  {userInitial.toUpperCase()}
                </div>

                {/* PRO */}
                <button className="oe-navbtn" onClick={openPortal}
                  style={badge(`${C.green}20`, `${C.green}50`, C.green)}>
                  PRO
                </button>

                {/* OUT — solid red, most visible */}
                <button className="oe-navbtn" onClick={onSignOut}
                  style={{
                    ...base,
                    padding: '6px 14px', borderRadius: 6,
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    background: C.red,
                    border: 'none',
                    color: '#fff',
                    boxShadow: `0 2px 8px ${C.red}55`,
                  }}>
                  OUT
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          MOBILE BOTTOM TAB BAR
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="oe-bot" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
        background: C.bgAlt,
        borderTop: `1px solid ${C.border}`,
        boxShadow: '0 -2px 12px rgba(0,0,0,.08)',
      }}>
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${isAdmin ? 5 : 4},1fr)` }}>
          {[
            { id:'dash',   icon:'◈', label:'DASH'   },
            { id:'scan',   icon:'⌁', label:'SCAN'   },
            { id:'trades', icon:'≡', label:'TRADES', link:'/app/trades' },
            { id:'tools',  icon:'⚙', label:'TOOLS'  },
            ...(isAdmin ? [{ id:'admin', icon:'★', label:'ADMIN' }] : []),
          ].map(t => {
            const active = t.id === 'tools' ? showTools : t.id === 'trades' ? isTradesPage : tab === t.id
            const col    = active ? C.green : C.dim

            if (t.link) return (
              <Link key={t.id} to={t.link} style={{
                ...mobileTab(active),
                color: col, textDecoration: 'none',
              }}>
                <span style={{ fontSize:20, color:col, lineHeight:1 }}>{t.icon}</span>
                <span style={{ fontSize:10, fontWeight:600, color:col, letterSpacing:.4 }}>{t.label}</span>
              </Link>
            )

            return (
              <button key={t.id}
                onClick={() => t.id === 'tools' ? setShowTools(p=>!p) : setTab(t.id)}
                style={mobileTab(active)}>
                <span style={{ fontSize:20, color:col, lineHeight:1 }}>{t.icon}</span>
                <span style={{ fontSize:10, fontWeight:600, color:col, letterSpacing:.4 }}>{t.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
