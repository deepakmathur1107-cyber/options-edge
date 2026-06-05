/**
 * src/Router.jsx
 *
 * Top-level router. Handles:
 *  - Clerk auth provider
 *  - BrowserRouter + all routes
 *  - Passes auth helpers down to pages as props
 *
 * Routes:
 *   /                  → App (main dashboard)
 *   /settings/alerts   → AlertSettings
 *   /trade-log         → TradeLog  (Phase 2, built next)
 *   *                  → redirect to /
 */

import { ClerkProvider, useAuth, useUser } from '@clerk/clerk-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import AlertSettings from './pages/AlertSettings'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// ── Auth-aware shell ───────────────────────────────────────────────────────
// Resolves Clerk helpers once and passes them as props to every page.
// This keeps pages decoupled from Clerk — they just receive getToken etc.
function AuthShell() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const { user } = useUser()

  if (!isLoaded) return null
  
  // Stripe customer portal redirect
  const openPortal = async () => {
    try {
      const token = await getToken()
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const { url } = await res.json()
      if (url) window.location.href = url
    } catch (e) {
      console.error('Portal error:', e)
    }
  }

  const authProps = {
    getToken,
    isLoaded,
    isSignedIn,
    userEmail:   user?.primaryEmailAddress?.emailAddress ?? '',
    userInitial: user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? '',
    openPortal,
    onSignOut:   () => window.location.href = '/sign-out',
  }

  return (
    <Routes>
      <Route path="/"                 element={<App {...authProps} />} />
      <Route path="/settings/alerts"  element={<AlertSettings {...authProps} />} />
      {/* Phase 2 — add when TradeLog is built: */}
      {/* <Route path="/trade-log" element={<TradeLog {...authProps} />} /> */}
      <Route path="*"                 element={<Navigate to="/" replace />} />
    </Routes>
  )
}

// ── Root export ────────────────────────────────────────────────────────────
export default function Router() {
  return (
<ClerkProvider 
  publishableKey={CLERK_KEY}
  afterSignInUrl="/"
  afterSignUpUrl="/"
  signInFallbackRedirectUrl="/"
  signUpFallbackRedirectUrl="/"
>
      <BrowserRouter>
        <AuthShell />
      </BrowserRouter>
    </ClerkProvider>
  )
}
