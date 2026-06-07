/**
 * src/components/AppNav.jsx
 *
 * Responsive navigation:
 *   Mobile  (<768px): fixed bottom tab bar
 *   Desktop (>=768px): sticky top nav bar
 */
import { Link, useLocation } from 'react-router-dom'

export default function AppNav({
  tab, setTab,
  isDark, C, setIsDark,
  userInitial, openPortal, onSignOut,
  tradierMode, autoOn,
  showTools, setShowTools,
}) {
  const location = useLocation()
  const isTradesPage = location.pathname === '/app/trades'
  const isAlertsPage = location.pathname === '/app/settings/alerts'
  const isMainApp    = location.pathname === '/app'
  const isSubPage    = isTradesPage || isAlertsPage

  const btnBase = {
    fontFamily: "'IBM Plex Mono', monospace",
    cursor: 'pointer', transition: 'all .15s',
  }

  const topTabBtn = (active) => ({
    ...btnBase,
    fontFamily: "'Inter', sans-serif",
    fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '5px 13px', borderRadius: 4,
    background: active ? `${C.green}18` : 'transparent',
    border: `1px solid ${active ? C.green : 'transparent'}`,
    color: active ? C.green : C.dim,
    fontSize: 12, letterSpacing: 0.3,
  })

  const bottomTabBtn = (active) => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 3, padding: '10px 4px',
    background: 'transparent', border: 'none', cursor: 'pointer',
    borderTop: `2px solid ${active ? C.green : 'transparent'}`,
    transition: 'border-color .2s', flex: 1,
    height: '58px', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  })

  const iconBtn = {
    ...btnBase,
    background: isDark ? '#1a2e3e' : '#e8edf4',
    border: `1px solid ${C.border}`,
    color: C.text,
    borderRadius: 6, padding: '6px 10px',
    fontSize: 14, lineHeight: 1,
    transition: 'all .15s',
  }

  const subLabel = isTradesPage ? '/ TRADES' : '/ ALERT SETTINGS'

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        @keyframes navpulse{0%,100%{opacity:1}50%{opacity:.35}}
        @media(max-width:767px){.oe-topnav{display:none!important}}
        @media(min-width:768px){.oe-bottomnav{display:none!important}}
        .oe-navbtn:hover{opacity:.75}
        .oe-toptab:hover{border-color:${C.green}50!important;color:${C.text}!important}
      `}</style>

      {/* ════════════════════════════════════════════════════════════
          DESKTOP TOP NAV
      ════════════════════════════════════════════════════════════ */}
      <div className="oe-topnav" style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: C.bgAlt, borderBottom: `1px solid ${C.border}`,
        boxShadow: isDark ? '0 2px 8px rgba(0,0,0,.3)' : '0 2px 8px rgba(0,0,0,.06)',
      }}>
        <div style={{
          maxWidth: 1100, margin: '0 auto', padding: '0 20px',
          height: 56, display: 'flex', alignItems: 'center', gap: 6,
        }}>

          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginRight: 12, flexShrink: 0 }}>
            <span style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 21, letterSpacing: 4, color: C.green, lineHeight: 1,
            }}>OPTIONS EDGE</span>
            <span style={{ fontSize: 8, color: C.dim, letterSpacing: 2 }}>v3.0</span>
          </div>

          {/* ── Main app nav tabs ── */}
          {isMainApp && (
            <div style={{ display: 'flex', gap: 2, flex: 1 }}>
              {['dash', 'scan'].map(id => (
                <button key={id} className="oe-navbtn oe-toptab"
                  onClick={() => setTab(id)}
                  style={topTabBtn(tab === id)}
                >
                  {{ dash: '◈', scan: '⌁' }[id]}
                  &nbsp;{id.toUpperCase()}
                </button>
              ))}
              <Link to="/app/trades" className="oe-navbtn oe-toptab" style={{
                ...topTabBtn(false), textDecoration: 'none',
              }}>
                ≡&nbsp;TRADES
              </Link>
              <button className="oe-navbtn oe-toptab"
                onClick={() => setShowTools(p => !p)}
                style={topTabBtn(showTools)}
              >
                ⚙&nbsp;TOOLS
              </button>
            </div>
          )}

          {/* ── Sub-page breadcrumb ── */}
          {isSubPage && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Link to="/app" style={{
                ...btnBase, color: C.dim, textDecoration: 'none', fontSize: 11,
                border: `1px solid ${C.border}`, padding: '5px 12px', borderRadius: 4,
                letterSpacing: .5, display: 'inline-flex', alignItems: 'center', gap: 5,
              }}>← BACK</Link>
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: 1.5 }}>{subLabel}</span>
            </div>
          )}

          {/* ── Right controls ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 'auto', flexShrink: 0 }}>
            {autoOn && (
              <span style={{
                fontSize: 9, color: C.green,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: C.green, display: 'inline-block',
                  boxShadow: `0 0 7px ${C.green}`,
                  animation: 'navpulse 1.1s infinite',
                }}/>
                LIVE
              </span>
            )}
            {tradierMode && (
              <span style={{
                fontSize: 8, fontWeight: 700, letterSpacing: 1,
                padding: '4px 9px', borderRadius: 4,
                background: tradierMode === 'sandbox' ? `${C.orange}20` : `${C.green}20`,
                border: `1px solid ${tradierMode === 'sandbox' ? C.orange+'60' : C.green+'60'}`,
                color: tradierMode === 'sandbox' ? C.orange : C.green,
              }}>{tradierMode.toUpperCase()}</span>
            )}
            <button className="oe-navbtn" onClick={() => setIsDark(p => !p)}
              title={isDark ? 'Light mode' : 'Dark mode'}
              style={{
                ...iconBtn,
                background: '#f59e0b22',
                border: `1px solid #f59e0b60`,
                color: '#f59e0b',
                fontWeight: 700,
              }}>
              {isDark ? '☀' : '🌙'}
            </button>
            <Link to="/app/settings/alerts" className="oe-navbtn" title="Alert settings" style={{
              ...iconBtn,
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
              background: `${C.blue}22`,
              border: `1px solid ${C.blue}60`,
              color: C.blue,
              fontWeight: 700,
            }}>🔔</Link>
            {userInitial && (
              <>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: `${C.green}20`, border: `1px solid ${C.green}40`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, color: C.green, fontWeight: 700,
                }}>{userInitial.toUpperCase()}</div>
                <button className="oe-navbtn" onClick={openPortal} style={{
                  ...btnBase,
                  background: `${C.green}15`,
                  border: `1px solid ${C.green}40`,
                  color: C.green, fontSize: 9, letterSpacing: .5,
                  borderRadius: 4, padding: '3px 8px', fontWeight: 600,
                }}>PRO</button>
                <button className="oe-navbtn" onClick={onSignOut} style={{
                  ...btnBase,
                  background: `${C.red}15`,
                  border: `1px solid ${C.red}40`,
                  color: C.red, borderRadius: 4, padding: '4px 9px',
                  fontSize: 9, letterSpacing: .5, fontWeight: 600,
                }}>OUT</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════
          MOBILE BOTTOM TAB BAR
      ════════════════════════════════════════════════════════════ */}
      <div className="oe-bottomnav" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
        background: C.bgAlt, borderTop: `1px solid ${C.border}`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {isMainApp ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)' }}>
            {[
              { id: 'dash', icon: '◈', label: 'DASH' },
              { id: 'scan', icon: '⌁', label: 'SCAN' },
              { id: 'trades', icon: '≡', label: 'TRADES', link: '/app/trades' },
              { id: 'tools', icon: '⚙', label: 'TOOLS' },
            ].map(t => {
              const active = t.id === 'tools' ? showTools : tab === t.id
              if (t.link) return (
                <Link key={t.id} to={t.link} style={{
                  ...bottomTabBtn(false),
                  color: C.dim, textDecoration: 'none',
                  borderTop: `2px solid transparent`,
                }}>
                  <span style={{ fontSize: 18, lineHeight: 1, color: C.dim }}>{t.icon}</span>
                  <span style={{ fontSize: 10, letterSpacing: .5, fontFamily: "'Inter',sans-serif", fontWeight: 600, color: C.dim }}>{t.label}</span>
                </Link>
              )
              return (
                <button key={t.id}
                  onClick={() => t.id === 'tools' ? setShowTools(p => !p) : setTab(t.id)}
                  style={bottomTabBtn(active)}
                >
                  <span style={{ fontSize: 18, lineHeight: 1, color: active ? C.green : C.dim }}>{t.icon}</span>
                  <span style={{ fontSize: 10, letterSpacing: .5, fontFamily: "'Inter',sans-serif", fontWeight: 600, color: active ? C.green : C.dim }}>{t.label}</span>
                </button>
              )
            })}
          </div>
        ) : (
          /* Sub-page minimal bottom bar */
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 16px',
          }}>
            <Link to="/app" style={{
              ...btnBase, color: C.green, textDecoration: 'none', fontSize: 11,
              border: `1px solid ${C.green}40`, padding: '6px 14px', borderRadius: 4, letterSpacing: 1,
            }}>← BACK</Link>
            <span style={{ fontSize: 10, color: C.dim, letterSpacing: 2 }}>
              {isTradesPage ? 'TRADES' : 'ALERTS'}
            </span>
            <button onClick={() => setIsDark(p => !p)} style={{
              ...iconBtn, fontSize: 15,
            }}>{isDark ? '☀' : '🌙'}</button>
          </div>
        )}
      </div>
    </>
  )
}
