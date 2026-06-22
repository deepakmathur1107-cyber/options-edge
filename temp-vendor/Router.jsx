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
// Was a static object always mirroring DARK_THEME, on the deliberate reasoning
// that Clerk's appearance API takes static values, not live theme state. That
// reasoning predates the decision to have pre-auth pages (Landing, this auth
// modal) follow the same persisted isDark preference as the authenticated
// app — so it's now a function of isDark instead, called fresh whenever
// theme changes, using the real DARK_THEME/LIGHT_THEME tokens rather than
// hand-copied hex (which is exactly how the elements.card/formButtonPrimary/
// etc. sub-blocks below drifted out of sync with the variables block during
// an earlier partial fix).
function getClerkAppearance(isDark) {
  const C = isDark ? DARK_THEME : LIGHT_THEME
  return {
    variables: {
      colorBackground:      C.bg,
      colorInputBackground: C.inputBg,
      colorInputText:       C.text,
      colorText:            C.text,
      colorTextSecondary:   C.subtext,
      colorPrimary:         C.orange,
      colorDanger:          C.red,
      borderRadius:         '8px',
      fontFamily:           'Inter, sans-serif',
      fontFamilyButtons:    'Inter, sans-serif',
    },
    elements: {
      rootBox: { width: '100%' },
      card: {
        background:   C.card,
        border:        `1px solid ${C.border}`,
        boxShadow:    C.shadowLg,
        borderRadius: '12px',
      },
      headerTitle: {
        color: C.text, fontWeight: 600,
        letterSpacing: '0.5px', fontSize: '24px', fontFamily: "'Fraunces',serif",
      },
      headerSubtitle: { color: C.dim },
      socialButtonsBlockButton: {
        border: `1px solid ${C.border}`, background: C.cardAlt, color: C.text,
      },
      socialButtonsBlockButtonText: { color: C.text },
      dividerLine:  { background: C.border },
      dividerText:  { color: C.dim },
      formFieldLabel: {
        color: C.dim, fontSize: '11px',
        fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
      },
      formFieldInput: {
        background: C.inputBg, border: `1px solid ${C.border}`,
        color: C.text, borderRadius: '6px',
      },
      formButtonPrimary: {
        background: C.orange, color: isDark ? '#1c1916' : '#ffffff', fontWeight: 700,
        letterSpacing: '0.5px', fontSize: '14px', borderRadius: '6px', border: 'none',
      },
      footerActionLink:          { color: C.orange },
      identityPreviewText:       { color: C.text },
      identityPreviewEditButton: { color: C.orange },
      formFieldSuccessText:      { color: C.green },
      alertText:                 { color: C.red },
      otpCodeFieldInput: {
        background: C.inputBg, border: `1px solid ${C.border}`, color: C.text,
      },
    },
  }
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

function PaywallScreen({ C, onStartTrial, loading, error, onSignOut, trialEligible }) {
  // null = still checking subscription status
  const checking  = trialEligible === null
  const hasTrial  = trialEligible === true

  const planLabel = checking
    ? 'PRO PLAN'
    : hasTrial
      ? 'PRO PLAN — 7-DAY FREE TRIAL'
      : 'PRO PLAN — SUBSCRIBE NOW'

  const priceNote = checking
    ? ''
    : hasTrial
      ? 'Cancel anytime · No charge for 7 days'
      : 'Billed immediately · Cancel anytime'

  const ctaLabel = loading
    ? 'REDIRECTING TO CHECKOUT...'
    : checking
      ? 'CHECKING ACCOUNT...'
      : hasTrial
        ? 'START FREE TRIAL'
        : 'SUBSCRIBE — $19/MONTH'

  const fineprint = checking
    ? ''
    : hasTrial
      ? 'Secured by Stripe · No card charged for 7 days'
      : 'Secured by Stripe · Your card will be charged $19 today'

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
          fontFamily: "'Fraunces',serif", fontSize: 28,
          color: C.green, letterSpacing: 3, marginBottom: 4,
        }}>OPTIONS EDGE</div>
        <div style={{ fontSize: 12, color: C.dim, letterSpacing: 1, marginBottom: 32 }}>
          PROFESSIONAL OPTIONS SCANNER
        </div>

        <div style={{
          background: C.bgDeep,
          border: `1px solid ${hasTrial || checking ? C.green : C.orange}40`,
          borderRadius: 10, padding: '24px 20px', marginBottom: 24,
        }}>
          <div style={{
            fontFamily: "'Fraunces',serif", fontSize: 20,
            color: hasTrial || checking ? C.green : C.orange,
            letterSpacing: 0.5, marginBottom: 8,
          }}>{planLabel}</div>

          <div style={{
            fontFamily: "'Fraunces',serif", fontSize: 42,
            color: C.text, lineHeight: 1, marginBottom: 4,
          }}>$19<span style={{ fontSize: 16, color: C.dim }}>/mo</span></div>

          {priceNote && (
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 16 }}>
              {priceNote}
            </div>
          )}

          <div style={{ textAlign: 'left' }}>
            {[
              'Live options scanner — real market data',
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

        {/* Trial-used warning banner */}
        {!checking && !hasTrial && (
          <div style={{
            background: `${C.orange}12`, border: `1px solid ${C.orange}40`,
            borderRadius: 6, padding: '10px 14px', marginBottom: 14,
            fontSize: 12, color: C.orange, lineHeight: 1.6,
          }}>
            ⚠️ Your 7-day free trial has already been used on this account.
            Subscribing now will charge your card immediately.
          </div>
        )}

        {error && (
          <div style={{
            background: `${C.red}15`, border: `1px solid ${C.red}40`,
            borderRadius: 6, padding: '10px 14px', marginBottom: 14,
            fontSize: 12, color: C.red, lineHeight: 1.5,
          }}>{error}</div>
        )}

        <button
          onClick={onStartTrial}
          disabled={loading || checking}
          style={{
            width: '100%', padding: '16px', borderRadius: 8,
            background: (loading || checking) ? `${C.green}40` : C.green,
            border: 'none', color: '#1c1916', fontWeight: 700,
            fontFamily: "'Fraunces',serif", fontSize: 16,
            letterSpacing: 0.5, cursor: (loading || checking) ? 'not-allowed' : 'pointer',
            marginBottom: 12,
          }}
        >
          {ctaLabel}
        </button>

        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6 }}>
          {fineprint}
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
      trialEligible={subStatus?.trial_eligible ?? null}
    />
  )
}

// ── Auth shell ────────────────────────────────────────────────────────────────
function AuthShell() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth()
  const { user }    = useUser()
  const { signOut } = useClerk()

  const [isDark, setIsDark] = useState(() => ls('isDark', '1') === '1')
  const C = isDark ? DARK_THEME : LIGHT_THEME

  useEffect(() => {
    try { localStorage.setItem('isDark', isDark ? '1' : '0') } catch {}
    // FIX: was '#090e14'/'#f4f7fb' — stale old-palette values, predates the
    // Signal redesign. This is the root <html> background visible during
    // initial paint before React mounts, on every route — was showing a
    // flash of the old navy/blue-gray regardless of any other theme fix.
    document.documentElement.style.background = C.bg
    // Chevron icon color (used by .expand-summary in index.css) needs to
    // differ by theme, but index.css is a static file with no access to
    // theme.js — bridge it via a CSS variable set here instead, so the
    // expand/collapse affordance is correct on every route, not just
    // wherever App.jsx's own scoped <style> tag happens to be mounted.
    document.documentElement.style.setProperty('--expand-chevron-color', C.orange)
    document.documentElement.style.setProperty('--expand-hint-color', C.dim)
    // Same bridge for the body{} rule in index.css — was hardcoded old
    // palette, now follows theme like everything else.
    document.documentElement.style.setProperty('--page-bg', C.bg)
    document.documentElement.style.setProperty('--page-text', C.text)
    document.documentElement.style.setProperty('--page-bg-deep', C.bgDeep)
    document.documentElement.style.setProperty('--page-border', C.border)
  }, [isDark, C])

  const [subStatus,       setSubStatus]       = useState(null)
  const [paywallErr,      setPaywallErr]       = useState('')
  const [checkoutLoading, setCheckoutLoading]  = useState(false)

  const stableGetToken = useCallback(async () => {
    try { return await getToken({ skipCache: true }) || null }
    catch { return null }
  }, [getToken])

  const fetchSubStatus = useCallback(() => {
    if (!isLoaded || !isSignedIn) { setSubStatus(null); return }
    if (userId && ADMIN_IDS.includes(userId)) {
      setSubStatus({ status: 'active', plan: 'admin', isAdmin: true, trial_eligible: false })
      return
    }
    stableGetToken().then(token => {
      if (!token) { setSubStatus({ status: 'active', plan: 'pro', trial_eligible: false }); return }
      fetch('/api/user/subscription', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(d => setSubStatus(d))
        .catch(() => setSubStatus({ status: 'active', plan: 'pro', trial_eligible: false }))
    })
  }, [isLoaded, isSignedIn, userId, stableGetToken])

  useEffect(() => { fetchSubStatus() }, [fetchSubStatus])

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

  const AuthShellStyle = {
    minHeight: '100vh',
    display: 'grid',
    gridTemplateColumns: 'clamp(0px, 45vw, 520px) 1fr',
    background: C.bg,
    fontFamily: "'Inter', sans-serif",
  }

  const AuthLeft = (
    <div style={{
      background: `linear-gradient(160deg, ${C.bgDeep} 0%, ${C.bg} 60%)`,
      borderRight: `1px solid ${C.border}`,
      padding: '48px 52px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      overflow: 'hidden',
    }} className="auth-left">
      <div>
        <a href="/" style={{ textDecoration: 'none' }}>
          <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 26, color: C.green, marginBottom: 4 }}>OPTIONS EDGE</div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, letterSpacing: 2 }}>OPTIONSEDGEFLOW.COM</div>
        </a>
      </div>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.blue, letterSpacing: 2, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, boxShadow: `0 0 8px ${C.green}` }} />
          LIVE OPTIONS SCANNER
        </div>
        <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 48, color: C.text, lineHeight: 1.15, marginBottom: 20 }}>
          Find the setup.<br />
          <span style={{ color: C.green }}>Skip the trap.</span>
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.subtext, lineHeight: 1.9 }}>
          GEX-weighted conviction scoring<br />
          6 hard-block filters active<br />
          Morning AI market brief daily<br />
          Real bid/ask market data
        </div>
      </div>

      <div style={{ background: C.bgDeep, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10 }}>
        <div style={{ background: C.cardAlt, borderBottom: `1px solid ${C.border}`, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.dim, letterSpacing: 1 }}>AUTO SCANNER</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.green, display: 'inline-block', boxShadow: `0 0 5px ${C.green}` }} />
            <span style={{ color: C.green, fontSize: 9 }}>LIVE</span>
          </span>
        </div>
        {[
          { sym: 'SPY',  t: 'CALL 545', dte: '21D', score: 88, g: 'A', c: C.green },
          { sym: 'NVDA', t: 'CALL 135', dte: '28D', score: 82, g: 'A', c: C.green },
          { sym: 'QQQ',  t: 'PUT  455', dte: '14D', score: 76, g: 'B', c: C.blue },
        ].map((r, i) => (
          <div key={i} style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${C.borderDim}`, opacity: i === 0 ? 1 : 0.5 }}>
            <span style={{ color: r.c, width: 32, fontWeight: 700 }}>{r.sym}</span>
            <span style={{ color: C.text, width: 64 }}>{r.t}</span>
            <span style={{ color: C.dim, width: 28 }}>{r.dte}</span>
            <div style={{ flex: 1, height: 2, background: C.border, borderRadius: 1 }}>
              <div style={{ height: '100%', width: `${r.score}%`, background: r.c, borderRadius: 1, opacity: 0.7 }} />
            </div>
            <span style={{ color: r.c, fontWeight: 700, width: 18 }}>{r.score}</span>
            <span style={{ color: r.c, background: `${r.c}15`, border: `1px solid ${r.c}40`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>{r.g}</span>
          </div>
        ))}
        <div style={{ padding: '6px 12px', color: C.dim, fontSize: 9, letterSpacing: 1 }}>GEX + OI + VOLUME SCORING · NOT FINANCIAL ADVICE</div>
      </div>

      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, lineHeight: 2 }}>
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
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.dim, letterSpacing: 2, marginBottom: 6, textTransform: 'uppercase' }}>Welcome back</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 26, color: C.text }}>Sign in to continue</div>
          </div>
          <SignIn appearance={getClerkAppearance(isDark)} routing="path" path="/sign-in" fallbackRedirectUrl="/app" />
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <a href="/" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, textDecoration: 'none' }}>← Back to home</a>
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
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.green, letterSpacing: 2, marginBottom: 6 }}>7-DAY FREE TRIAL</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 26, color: C.text }}>Create your account</div>
          </div>
          <SignUp appearance={getClerkAppearance(isDark)} routing="path" path="/sign-up" fallbackRedirectUrl="/app" />
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <a href="/" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, textDecoration: 'none' }}>← Back to home</a>
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
