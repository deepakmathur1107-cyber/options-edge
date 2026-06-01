// api/user/subscription.js
// Returns the subscription status for the authenticated user.
// Called by the frontend Router on every protected page load.

const { createClient } = require('@supabase/supabase-js')
const { createClerkClient } = require('@clerk/backend')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  // Verify Clerk JWT
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await clerk.verifyToken(token)
    clerkUserId = payload.sub
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token: ' + e.message })
  }

  // Look up subscription in Supabase
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end, stripe_subscription_id')
    .eq('clerk_id', clerkUserId)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })

  if (!data) {
    // No subscription record at all — user just signed up
    return res.status(200).json({ status: 'inactive', plan: null })
  }

  // Check if subscription period has expired (belt + suspenders on top of Stripe webhook)
  const now = new Date()
  const periodEnd = data.current_period_end ? new Date(data.current_period_end) : null
  let effectiveStatus = data.status

  if (effectiveStatus === 'active' || effectiveStatus === 'trialing') {
    if (periodEnd && periodEnd < now) {
      effectiveStatus = 'expired'
    }
  }

  return res.status(200).json({
    status:            effectiveStatus,
    plan:              data.plan,
    current_period_end: data.current_period_end,
    subscription_id:   data.stripe_subscription_id,
  })
}
