/**
 * src/Router.jsx
 *
 * - isDark lives here, shared to all pages
 * - Auth guard: unauthenticated users are redirected to /sign-in
 * - Sign out goes to /sign-in
 * - authProps.getToken is a stable wrapper that always returns a fresh JWT
 */
import { useState, useEffect } from 'react'
import {
  ClerkProvider, useAuth, useUser,
  SignIn, SignUp, useClerk,
} from '@clerk/clerk-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App           from './App'
import AlertSettings from './pages/AlertSettings'
import TradeLog      from './pages/TradeLog'
import { DARK_THEME, LIGHT_THEME } from './theme'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const ls = (key, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

// ── Auth guard ────────────────────────────────────────────────────────────────
// Wraps any protected route. Redirects to /sign-in if not signed in.
function Protected({ children, isLoaded, isSignedIn }) {
  if (!isLoaded) return null                          // wait for Clerk
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
  return children
}

function AuthShell() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const { user }    = useUser()
  const { signOut } = useClerk()

  // ── Theme lives here ──────────────────────────────────────────────────────
  const [isDark, setIsDark] = useState(() => ls('isDark', '1') === '1')

  useEffect(() => {
    try { localStorage.setItem('isDark', isDark ? '1' : '0') } catch {}
    document.documentElement.style.background = isDark ? '#090e14' : '#f4f7fb'
  }, [isDark])

  const C = isDark ? DARK_THEME : LIGHT_THEME

  // ── Loading screen ────────────────────────────────────────────────────────
  if (!isLoaded) return (
    <div style={{
      minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: C.bg, fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 12, color: C.dim, letterSpacing: 2,
    }}>
      LOADING…
    </div>
  )

  // ── Stripe portal ─────────────────────────────────────────────────────────
  const openPortal = async () => {
    try {
      const token = await getToken()
      const res   = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const { url } = await res.json()
      if (url) window.location.href = url
    } catch (e) { console.error('Portal error:', e) }
  }

  // ── Sign out ──────────────────────────────────────────────────────────────
  const handleSignOut = () => {
    signOut().then(() => {
      window.location.href = '/sign-in'
    }).catch(() => {
      window.location.href = '/sign-in'
    })
  }

  // ── Stable getToken wrapper ───────────────────────────────────────────────
  const stableGetToken = async () => {
    try {
      const token = await getToken({ skipCache: true })
      return token || null
    } catch {
      return null
    }
  }

  // ── authProps — everything every page needs ───────────────────────────────
  const authProps = {
    getToken:    stableGetToken,
    isLoaded,
    isSignedIn,
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

  const guard = { isLoaded, isSignedIn }

  return (
    <Routes>
      {/* ── Protected routes ── */}
      <Route path="/app/settings/alerts" element={
        <Protected {...guard}><AlertSettings {...authProps} /></Protected>
      } />
      <Route path="/app/trades" element={
        <Protected {...guard}><TradeLog {...authProps} /></Protected>
      } />
      <Route path="/app" element={
        <Protected {...guard}><App {...authProps} /></Protected>
      } />

      {/* ── Auth routes ── */}
      <Route path="/sign-in/*"
        element={<SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/app" />} />
      <Route path="/sign-up/*"
        element={<SignUp routing="path" path="/sign-up" fallbackRedirectUrl="/app" />} />

      {/* ── Catch-all: unauthenticated → sign-in, authenticated → app ── */}
      <Route path="/" element={
        isSignedIn ? <Navigate to="/app" replace /> : <Navigate to="/sign-in" replace />
      } />
      <Route path="*" element={
        isSignedIn ? <Navigate to="/app" replace /> : <Navigate to="/sign-in" replace />
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
