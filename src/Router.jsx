/**
 * src/Router.jsx
 *
 * Top-level router.
 * NOTE: Clerk dev instance serves app at /app base path.
 * All routes prefixed with /app until custom domain + Clerk Production is set up.
 */
import { ClerkProvider, useAuth, useUser, SignIn, SignUp } from '@clerk/clerk-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import AlertSettings from './pages/AlertSettings'
import TradeLog from './pages/TradeLog'

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
      <Route path="/app/settings/alerts" element={<AlertSettings {...authProps} />} />
      <Route path="/app/trades"          element={<TradeLog {...authProps} />} />
      <Route path="/app"                 element={<App {...authProps} />} />
      <Route path="/sign-in/*"           element={<SignIn routing="path" path="/sign-in" afterSignInUrl="/app" />} />
      <Route path="/sign-up/*"           element={<SignUp routing="path" path="/sign-up" afterSignUpUrl="/app" />} />
      <Route path="/"                    element={<Navigate to="/app" replace />} />
      <Route path="*"                    element={<Navigate to="/app" replace />} />
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
