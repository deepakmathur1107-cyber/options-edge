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
          }}>$29<span style={{ fontSize: 16, color: C.dim }}>/mo</span></div>
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

  const signInPage = (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#0d1117', padding: 24,
    }}>
      <div style={{
        fontFamily: "'Bebas Neue', sans-serif", fontSize: 22,
        color: '#00ff88', letterSpacing: 3, marginBottom: 24,
      }}>OPTIONS EDGE</div>
      <SignIn appearance={clerkAppearance} routing="path" path="/sign-in" fallbackRedirectUrl="/app" />
    </div>
  )

  const signUpPage = (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#0d1117', padding: 24,
    }}>
      <div style={{
        fontFamily: "'Bebas Neue', sans-serif", fontSize: 22,
        color: '#00ff88', letterSpacing: 3, marginBottom: 24,
      }}>OPTIONS EDGE</div>
      <SignUp appearance={clerkAppearance} routing="path" path="/sign-up" fallbackRedirectUrl="/app" />
    </div>
  )

  return (
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
