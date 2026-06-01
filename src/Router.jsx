import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useUser, useAuth, SignIn, SignUp } from '@clerk/clerk-react'
import Landing  from './Landing'
import Paywall  from './Paywall'
import App      from './App'

// ─── Subscription check ───────────────────────────────────────────────────────
// Calls /api/user/subscription to get live status from Supabase.
// Cached for 5 minutes in sessionStorage to avoid hammering the API on every render.
async function fetchSubStatus(getToken) {
  const CACHE_KEY = 'sub_status_cache'
  const CACHE_TTL = 5 * 60 * 1000  // 5 minutes
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null')
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.status
  } catch {}
  try {
    const token = await getToken()
    const res = await fetch('/api/user/subscription', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json()
    const status = data.status || 'inactive'
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ status, ts: Date.now() })) } catch {}
    return status
  } catch {
    return 'inactive'
  }
}

// ─── Spinner ────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ background:'#090e14', minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16 }}>
      <div style={{ width:36, height:36, border:'3px solid #1a2e3e', borderTop:'3px solid #00ff88', borderRadius:'50%', animation:'spin 0.8s linear infinite' }}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#4a7a8a', letterSpacing:2 }}>LOADING</div>
    </div>
  )
}

// ─── Protected route — requires auth + active subscription ──────────────────
function Protected() {
  const { isLoaded, isSignedIn } = useUser()
  const { getToken }             = useAuth()
  const navigate                 = useNavigate()
  const location                 = useLocation()
  const [subStatus, setSubStatus] = useState(null)   // null = loading

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) { navigate('/', { replace: true }); return }
    // Check subscription
    fetchSubStatus(getToken).then(s => {
      setSubStatus(s)
      // Clear cache if returning from Stripe success
      if (location.search.includes('sub=success')) {
        try { sessionStorage.removeItem('sub_status_cache') } catch {}
      }
    })
  }, [isLoaded, isSignedIn, location.search])

  // Re-check after returning from Stripe
  useEffect(() => {
    if (location.search.includes('sub=success')) {
      setSubStatus(null)  // force re-fetch
      fetchSubStatus(getToken).then(setSubStatus)
    }
  }, [location.search])

  if (!isLoaded || subStatus === null) return <Spinner />
  if (!isSignedIn) return <Navigate to="/" replace />
  if (subStatus !== 'active' && subStatus !== 'trialing') return <Paywall />
  return <App />
}

// ─── Router ──────────────────────────────────────────────────────────────────
export default function Router() {
  const { isLoaded, isSignedIn } = useUser()

  if (!isLoaded) return <Spinner />

  return (
    <Routes>
      {/* Public */}
      <Route path="/"      element={isSignedIn ? <Navigate to="/app" replace /> : <Landing />} />
      <Route path="/sign-in" element={
        <div style={{ background:'#090e14', minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
          <SignIn routing="hash" afterSignInUrl="/app" />
        </div>
      }/>
      <Route path="/sign-up" element={
        <div style={{ background:'#090e14', minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
          <SignUp routing="hash" afterSignUpUrl="/app" />
        </div>
      }/>

      {/* Protected — auth + subscription required */}
      <Route path="/app" element={<Protected />} />
      <Route path="/app/*" element={<Protected />} />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
