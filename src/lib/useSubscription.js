/**
 * useSubscription.js
 * Returns subscription status for the current Clerk user.
 * Admins always get { active: true, plan: 'admin', loading: false }.
 */

import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { isAdmin } from './adminBypass'

export default function useSubscription() {
  const { userId, getToken, isLoaded } = useAuth()
  const [status, setStatus] = useState({
    active: false,
    plan: null,
    loading: true,
    error: null,
  })

  useEffect(() => {
    if (!isLoaded) return

    // Admin bypass — no Supabase/Stripe lookup needed
    if (isAdmin(userId)) {
      setStatus({ active: true, plan: 'admin', loading: false, error: null })
      return
    }

    if (!userId) {
      setStatus({ active: false, plan: null, loading: false, error: null })
      return
    }

    let cancelled = false

    async function fetchSubscription() {
      try {
        const token = await getToken()
        // Fixed: was incorrectly /api/subscription (404). Correct path is /api/user/subscription
        const res = await fetch('/api/user/subscription', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()

        if (!cancelled) {
          const isActive = data.status === 'active' || data.status === 'trialing'
          setStatus({
            active: isActive,
            plan:   data.plan ?? null,
            loading: false,
            error: null,
          })
        }
      } catch (err) {
        if (!cancelled) {
          setStatus(prev => ({ ...prev, loading: false, error: err.message }))
        }
      }
    }

    fetchSubscription()
    return () => { cancelled = true }
  }, [userId, isLoaded, getToken])

  return status
}
