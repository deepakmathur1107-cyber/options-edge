import { useState, useEffect, useCallback } from 'react'
import {
  ClerkProvider, useAuth, useUser,
  SignIn, SignUp, useClerk,
} from '@clerk/clerk-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App      from './App'
import TradeLog from './pages/TradeLog'
import Landing  from './Landing'
import { DARK_THEME, LIGHT_THEME } from './theme'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const ADMIN_IDS = (import.meta.env.VITE_ADMIN_CLERK_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const ls = (key, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

// ── Clerk appearance ──────────────────────────────────────────────────────────
const clerkAppearance = {
  variables: {
    colorBackground:      '#0d1117',
    colorInputBackground: '#161b22',
    colorInputText:       '#e6edf3',
    colorText:            '#e6edf3',
    colorTextSecondary:   '#8b949e',
    colorPrimary:         '#00ff88',
    colorDanger:          '#ff6b6b',
    borderRadius:         '8px',
    fontFamily:           'Inter, sans-serif',
    fontFamilyButtons:    'Inter, sans-serif',
  },
  elements: {
    rootBox: { width: '100%' },
    card: {
      background:   '#161b22',
      border:       '1px solid #30363d',
      boxShadow:    '0 16px 48px rgba(0,0,0,0.6)',
      borderRadius: '12px',
    },
    headerTitle: {
      color: '#e6edf3', fontWeight: 700,
      letterSpacing: '2px', fontSize: '24px',
    },
    headerSubtitle: { color: '#8b949e' },
    socialButtonsBlockButton: {
      border: '1px solid #30363d', background: '#1c2128', color: '#e6edf3',
    },
    socialButtonsBlockButtonText: { color: '#e6edf3' },
    dividerLine:  { background: '#30363d' },
    dividerText:  { color: '#8b949e' },
    formFieldLabel: {
      color: '#8b949e', fontSize: '11px',
      fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
    },
    formFieldInput: {
      background: '#0d1117', border: '1px solid #30363d',
      color: '#e6edf3', borderRadius: '6px',
    },
    formButtonPrimary: {
      background: '#00ff88', color: '#000', fontWeight: 700,
      letterSpacing: '1px', fontSize: '14px', borderRadius: '6px', border: 'none',
    },
    footerActionLink:          { color: '#00ff88' },
    identityPreviewText:       { color: '#e6edf3' },
    identityPreviewEditButton: { color: '#00ff88' },
    formFieldSuccessText:      { color: '#00ff88' },
    alertText:                 { color: '#ff6b6b' },
    otpCodeFieldInput: {
      background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    },
  },
}

// ── Pure UI components — defined OUTSIDE AuthShell so React never recreates them ──

function LoadingScreen({ C, message }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: C.bg, fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 12, color: C.dim, letterSpacing: 2,
    }}>
      {message || 'LOADING...'}
    </div>
  )
}

function PaywallScreen({ C, onStartTrial, loading, error, onSignOut }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: C.bg,
      fontFamily: "'Inter', sans-serif", padding: 24,
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: '40px 36px', maxWidth: 440, width: '100%',
        boxShadow: '0 16px 48px rgba(0,0,0,0.4)', textAlign: 'center',
      }}>
        <div style={{
          fontFamily: "'Bebas Neue', sans-serif", fontSize: 28,
          color: C.green, letterSpacing: 3, marginBottom: 4,
        }}>OPTIONS EDGE</div>
        <div style={{ fontSize: 12, color: C.dim, letterSpacing: 1, marginBottom: 32 }}>
          PROFESSIONAL OPTIONS SCANNER
        </div>

        <div style={{
          background: C.bgDeep, border: `1px solid ${C.green}40`,
          borderRadius: 10, padding: '24px 20px', marginBottom: 24,
        }}>
          <div style={{
            fontFamily: "'Bebas Neue', sans-serif", fontSize: 20,
            color: C.green, letterSpacing: 2, marginBottom: 8,
          }}>PRO PLAN — 7-DAY FREE TRIAL</div>
          <div style={{
            fontFamily: "'Bebas Neue', sans-serif", fontSize: 42,
            color: C.text, lineHeight: 1, marginBottom: 4,
          }}>$19<span style={{ fontSize: 16, color: C.dim }}>/mo</span></div>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 16 }}>
            Cancel anytime · No charge for 7 days
          </div>
          <div style={{ textAlign: 'left' }}>
            {[
              'Live options scanner — real Tradier data',
              'SPX / NDX index setups across all timeframes',
              'GEX + conviction scoring engine',
              'Morning readout — daily market brief',
              'Email alerts on high-conviction setups',
              'Trade journal & strategy backtest',
            ].map((feat, i) => (
              <div key={i} style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                fontSize: 12, color: C.subtext, marginBottom: 6,
              }}>
                <span style={{ color: C.green, flexShrink: 0, marginTop: 1 }}>✓</span>
                {feat}
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div style={{
            background: `${C.red}15`, border: `1px solid ${C.red}40`,
            borderRadius: 6, padding: '10px 14px', marginBottom: 14,
            fontSize: 12, color: C.red, lineHeight: 1.5,
          }}>{error}</div>
        )}

        <button
          onClick={onStartTrial}
          disabled={loading}
          style={{
            width: '100%', padding: '16px', borderRadius: 8,
            background: loading ? `${C.green}40` : C.green,
            border: 'none', color: '#000', fontWeight: 700,
            fontFamily: "'Bebas Neue', sans-serif", fontSize: 16,
            letterSpacing: 2, cursor: loading ? 'not-allowed' : 'pointer',
            marginBottom: 12,
          }}
        >
          {loading ? 'REDIRECTING TO CHECKOUT...' : 'START FREE TRIAL'}
        </button>

        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6 }}>
          Secured by Stripe · No card charged for 7 days
        </div>
        <button
          onClick={onSignOut}
          style={{
            marginTop: 20, background: 'transparent', border: 'none',
            color: C.subtext, fontSize: 11, cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >Sign out</button>
      </div>
    </div>
  )
}

// ── SubscriptionGate — defined OUTSIDE AuthShell ──────────────────────────────
// Receives all state as props. Never redefined on re-render = no flicker.
function SubscriptionGate({ children, isSignedIn, subStatus, isActive, C, startTrial, checkoutLoading, paywallErr, handleSignOut }) {
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
  if (subStatus === null) return <LoadingScreen C={C} message="CHECKING SUBSCRIPTION..." />
  if (isActive) return children
  return (
    <PaywallScreen
      C={C}
      onStartTrial={startTrial}
      loading={checkoutLoading}
      error={paywallErr}
      onSignOut={handleSignOut}
    />
  )
}

// ── Auth shell ────────────────────────────────────────────────────────────────
function AuthShell() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth()
  const { user }    = useUser()
  const { signOut } = useClerk()

  const [isDark, setIsDark] = useState(() => ls('isDark', '1') === '1')

  useEffect(() => {
    try { localStorage.setItem('isDark', isDark ? '1' : '0') } catch {}
    document.documentElement.style.background = isDark ? '#090e14' : '#f4f7fb'
  }, [isDark])

  const C = isDark ? DARK_THEME : LIGHT_THEME

  const [subStatus,       setSubStatus]       = useState(null)
  const [paywallErr,      setPaywallErr]       = useState('')
  const [checkoutLoading, setCheckoutLoading]  = useState(false)

  const stableGetToken = useCallback(async () => {
    try { return await getToken({ skipCache: true }) || null }
    catch { return null }
  }, [getToken])

  // Fetch subscription status — called on mount and on tab focus
  const fetchSubStatus = useCallback(() => {
    if (!isLoaded || !isSignedIn) { setSubStatus(null); return }
    // Admin client-side bypass
    if (userId && ADMIN_IDS.includes(userId)) {
      setSubStatus({ status: 'active', plan: 'admin', isAdmin: true })
      return
    }
    stableGetToken().then(token => {
      if (!token) { setSubStatus({ status: 'active', plan: 'pro' }); return }
      fetch('/api/user/subscription', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(d => setSubStatus(d))
        .catch(() => setSubStatus({ status: 'active', plan: 'pro' }))
    })
  }, [isLoaded, isSignedIn, userId, stableGetToken])

  // Check subscription on sign-in
  useEffect(() => { fetchSubStatus() }, [fetchSubStatus])

  // Re-check when user returns to the tab (catches mid-session expiry)
  useEffect(() => {
    const onFocus = () => { if (isSignedIn) fetchSubStatus() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [isSignedIn, fetchSubStatus])

  const openPortal = async () => {
    try {
      const token = await stableGetToken()
      const res   = await fetch('/api/stripe/portal', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const { url } = await res.json()
      if (url) window.location.href = url
    } catch (e) { console.error('Portal error:', e) }
  }

  const startTrial = useCallback(async () => {
    setCheckoutLoading(true)
    setPaywallErr('')
    try {
      const token = await stableGetToken()
      const res   = await fetch('/api/stripe/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ email: user?.primaryEmailAddress?.emailAddress || '' }),
      })
      const d = await res.json()
      if (d.url) {
        window.location.href = d.url
      } else {
        setPaywallErr(d.error || 'Checkout failed — please try again.')
        setCheckoutLoading(false)
      }
    } catch (e) {
      setPaywallErr('Network error: ' + e.message)
      setCheckoutLoading(false)
    }
  }, [stableGetToken, user])

  const handleSignOut = useCallback(() => {
    signOut()
      .then(() => { window.location.href = '/sign-in' })
      .catch(() => { window.location.href = '/sign-in' })
  }, [signOut])

  if (!isLoaded) return <LoadingScreen C={C} message="LOADING..." />

  const isActive = subStatus?.status === 'active'
                || subStatus?.status === 'trialing'
                || subStatus?.isAdmin === true

  const authProps = {
    getToken:    stableGetToken,
    isLoaded,
    isSignedIn,
    isAdmin:     subStatus?.isAdmin === true,
    subStatus,
    userEmail:   user?.primaryEmailAddress?.emailAddress ?? '',
    userInitial: user?.firstName?.[0]
                 ?? user?.primaryEmailAddress?.emailAddress?.[0]
                 ?? '',
    openPortal,
    onSignOut:   handleSignOut,
    isDark,
    setIsDark,
    C,
  }

  // Gate props passed to the stable SubscriptionGate component
  const gateProps = {
    isSignedIn,
    subStatus,
    isActive,
    C,
    startTrial,
    checkoutLoading,
    paywallErr,
    handleSignOut,
  }

  // ── Shared auth page shell ──────────────────────────────────────────────────
  const AuthShellStyle = {
    minHeight: '100vh',
    display: 'grid',
    gridTemplateColumns: 'clamp(0px, 45vw, 520px) 1fr',
    background: '#090e14',
    fontFamily: "'Inter', sans-serif",
  }

  // Left panel — branding + value props (hidden on mobile via CSS)
  const AuthLeft = (
    <div style={{
      background: 'linear-gradient(160deg, #0a1a0f 0%, #090e14 60%)',
      borderRight: '1px solid #1a2e3e',
      padding: '48px 52px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      overflow: 'hidden',
    }} className="auth-left">
      {/* Logo */}
      <div>
        <a href="/" style={{ textDecoration: 'none' }}>
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, color: '#00ff88', letterSpacing: 4, marginBottom: 4 }}>OPTIONS EDGE</div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2a4a5a', letterSpacing: 2 }}>OPTIONSEDGEFLOW.COM</div>
        </a>
      </div>

      {/* Hero text */}
      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#00c8ff', letterSpacing: 2, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 8px #00ff88' }} />
          LIVE OPTIONS SCANNER
        </div>
        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 52, color: '#c8d8e8', letterSpacing: 3, lineHeight: 1.0, marginBottom: 20 }}>
          FIND THE<br />SETUP.<br />
          <span style={{ color: '#00ff88' }}>SKIP THE<br />TRAP.</span>
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#4a7a8a', lineHeight: 1.9 }}>
          GEX-weighted conviction scoring<br />
          6 hard-block filters active<br />
          Morning AI market brief daily<br />
          Real Tradier bid/ask data
        </div>
      </div>

      {/* Mini scanner mockup */}
      <div style={{ background: '#060c14', border: '1px solid #1a2e3e', borderRadius: 8, overflow: 'hidden', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10 }}>
        <div style={{ background: '#0a1520', borderBottom: '1px solid #1a2e3e', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#2a4a5a', letterSpacing: 1 }}>AUTO SCANNER</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#00ff88', display: 'inline-block', boxShadow: '0 0 5px #00ff88' }} />
            <span style={{ color: '#00ff88', fontSize: 9 }}>LIVE</span>
          </span>
        </div>
        {[
          { sym: 'SPY',  t: 'CALL 545', dte: '21D', score: 88, g: 'A', c: '#00ff88' },
          { sym: 'NVDA', t: 'CALL 135', dte: '28D', score: 82, g: 'A', c: '#00ff88' },
          { sym: 'QQQ',  t: 'PUT  455', dte: '14D', score: 76, g: 'B', c: '#00c8ff' },
        ].map((r, i) => (
          <div key={i} style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #0a1520', opacity: i === 0 ? 1 : 0.5 }}>
            <span style={{ color: r.c, width: 32, fontWeight: 700 }}>{r.sym}</span>
            <span style={{ color: '#c8d8e8', width: 64 }}>{r.t}</span>
            <span style={{ color: '#2a4a5a', width: 28 }}>{r.dte}</span>
            <div style={{ flex: 1, height: 2, background: '#0d1e2a', borderRadius: 1 }}>
              <div style={{ height: '100%', width: `${r.score}%`, background: r.c, borderRadius: 1, opacity: 0.7 }} />
            </div>
            <span style={{ color: r.c, fontWeight: 700, width: 18 }}>{r.score}</span>
            <span style={{ color: r.c, background: `${r.c}15`, border: `1px solid ${r.c}40`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>{r.g}</span>
          </div>
        ))}
        <div style={{ padding: '6px 12px', color: '#1a3040', fontSize: 9, letterSpacing: 1 }}>GEX + OI + VOLUME SCORING · NOT FINANCIAL ADVICE</div>
      </div>

      {/* Social proof line */}
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#1a3040', lineHeight: 2 }}>
        7-day free trial · $19/month · Cancel anytime
      </div>
    </div>
  )

  const signInPage = (
    <div style={AuthShellStyle}>
      {AuthLeft}
      <div className="auth-right" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 32px' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ marginBottom: 28, textAlign: 'center' }}>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 13, color: '#4a7a8a', letterSpacing: 3, marginBottom: 6 }}>WELCOME BACK</div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: '#c8d8e8', letterSpacing: 2 }}>SIGN IN TO CONTINUE</div>
          </div>
          <SignIn appearance={clerkAppearance} routing="path" path="/sign-in" forceRedirectUrl="/app" />
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <a href="/" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2a4a5a', textDecoration: 'none' }}>← Back to home</a>
          </div>
        </div>
      </div>
    </div>
  )

  const signUpPage = (
    <div style={AuthShellStyle}>
      {AuthLeft}
      <div className="auth-right" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 32px' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ marginBottom: 28, textAlign: 'center' }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#00ff88', letterSpacing: 2, marginBottom: 6 }}>7-DAY FREE TRIAL</div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: '#c8d8e8', letterSpacing: 2 }}>CREATE YOUR ACCOUNT</div>
          </div>
          <SignUp appearance={clerkAppearance} routing="path" path="/sign-up" forceRedirectUrl="/app" />
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <a href="/" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2a4a5a', textDecoration: 'none' }}>← Back to home</a>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <>
    <style>{`
      @media (max-width: 640px) {
        .auth-left { display: none !important; }
        .auth-right { padding: 32px 20px !important; }
      }
    `}</style>
    <Routes>
      <Route path="/app/settings/alerts" element={<Navigate to="/app" replace />} />
      <Route path="/app/trades" element={
        <SubscriptionGate {...gateProps}><TradeLog {...authProps} /></SubscriptionGate>
      } />
      <Route path="/app" element={
        <SubscriptionGate {...gateProps}><App {...authProps} /></SubscriptionGate>
      } />
      <Route path="/sign-in/*" element={signInPage} />
      <Route path="/sign-up/*" element={signUpPage} />
      <Route path="/" element={
        isSignedIn ? <Navigate to="/app" replace /> : <Landing />
      } />
      <Route path="*" element={
        isSignedIn ? <Navigate to="/app" replace /> : <Navigate to="/" replace />
      } />
    </Routes>
  )
    </>
  )
}

export default function Router() {
  return (
    <ClerkProvider
      publishableKey={CLERK_KEY}
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
    >
      <BrowserRouter>
        <AuthShell />
      </BrowserRouter>
    </ClerkProvider>
  )
}
