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
 *   /app               → redirect to / (Clerk dev instance default)
 *   /settings/alerts   → AlertSettings
 *   /sign-in           → Clerk SignIn component
 *   /sign-up           → Clerk SignUp component
 *   *                  → redirect to /
 */

import { ClerkProvider, useAuth, useUser, SignIn, SignUp } from '@clerk/clerk-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import AlertSettings from './pages/AlertSettings'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

function AuthShell() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const { user } = useUser()

  if (!isLoaded) return null

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
    onSignOut: () => window.location.href = '/sign-out',
  }

  return (
    <Routes>
      <Route path="/"                element={<App {...authProps} />} />
      <Route path="/app"             element={<Navigate to="/" replace />} />
      <Route path="/settings/alerts" element={<AlertSettings {...authProps} />} />
      <Route path="/sign-in/*"       element={<SignIn routing="path" path="/sign-in" afterSignInUrl="/" />} />
      <Route path="/sign-up/*"       element={<SignUp routing="path" path="/sign-up" afterSignUpUrl="/" />} />
      <Route path="*"                element={<Navigate to="/" replace />} />
    </Routes>
  )
}

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
