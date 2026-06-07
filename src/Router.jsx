/**
 * src/Router.jsx
 * 
 * - isDark lives here, shared to all pages
 * - Sign out goes to /sign-in (not / which bounces back to /app)
 * - authProps.getToken is a stable wrapper that always returns a fresh JWT
 */
import { useState, useEffect } from 'react'
import {
  ClerkProvider, useAuth, useUser,
  SignIn, SignUp, useClerk,
} from '@clerk/clerk-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App          from './App'
import AlertSettings from './pages/AlertSettings'
import TradeLog     from './pages/TradeLog'
import { DARK_THEME, LIGHT_THEME } from './theme'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const ls = (key, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
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

  // ── Sign out → /sign-in (NOT / which bounces back to /app) ───────────────
  const handleSignOut = () => {
    signOut().then(() => {
      window.location.href = '/sign-in'
    }).catch(() => {
      window.location.href = '/sign-in'
    })
  }

  // ── Stable getToken wrapper ───────────────────────────────────────────────
  // Always returns a fresh token or null. Never throws.
  const stableGetToken = async () => {
    try {
      const token = await getToken({ skipCache: false })
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

  return (
    <Routes>
      <Route path="/app/settings/alerts" element={<AlertSettings {...authProps} />} />
      <Route path="/app/trades"          element={<TradeLog      {...authProps} />} />
      <Route path="/app"                 element={<App           {...authProps} />} />
      <Route path="/sign-in/*"
        element={<SignIn routing="path" path="/sign-in" afterSignInUrl="/app" />} />
      <Route path="/sign-up/*"
        element={<SignUp routing="path" path="/sign-up" afterSignUpUrl="/app" />} />
      <Route path="/"  element={<Navigate to="/app" replace />} />
      <Route path="*"  element={<Navigate to="/app" replace />} />
    </Routes>
  )
}

export default function Router() {
  return (
    <ClerkProvider
      publishableKey={CLERK_KEY}
      afterSignInUrl="/app"
      afterSignUpUrl="/app"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
    >
      <BrowserRouter>
        <AuthShell />
      </BrowserRouter>
    </ClerkProvider>
  )
}
