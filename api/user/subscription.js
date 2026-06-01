// api/user/subscription.js
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function verifyClerkToken(token) {
  const res = await fetch('https://api.clerk.com/v1/tokens/verify', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
    },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error('Token verification failed')
  return res.json()
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' })

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  let clerkUserId
  try {
    const payload = await verifyClerkToken(token)
    clerkUserId   = payload.sub
    if (!clerkUserId) throw new Error('No sub')
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end, stripe_subscription_id')
    .eq('clerk_id', clerkUserId)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  if (!data)  return res.status(200).json({ status: 'inactive', plan: null })

  const now          = new Date()
  const periodEnd    = data.current_period_end ? new Date(data.current_period_end) : null
  let effectiveStatus = data.status

  if ((effectiveStatus === 'active' || effectiveStatus === 'trialing') && periodEnd && periodEnd < now) {
    effectiveStatus = 'expired'
  }

  return res.status(200).json({
    status:             effectiveStatus,
    plan:               data.plan,
    current_period_end: data.current_period_end,
    subscription_id:    data.stripe_subscription_id,
  })
}
