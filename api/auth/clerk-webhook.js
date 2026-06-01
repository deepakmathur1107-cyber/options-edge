// api/auth/clerk-webhook.js
// Called by Clerk when a new user signs up.
// Creates the user record in Supabase so we can attach subscriptions to them.
// Set the webhook URL in Clerk Dashboard → Webhooks → Add Endpoint:
//   https://your-app.vercel.app/api/auth/clerk-webhook
//   Events: user.created

const { createClient } = require('@supabase/supabase-js')
const crypto = require('crypto')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function verifyClerkWebhook(payload, headers) {
  // Clerk sends svix-id, svix-timestamp, svix-signature headers
  // Simple timestamp check — for production use the svix npm package
  const tolerance = 5 * 60 * 1000  // 5 minutes
  const ts = parseInt(headers['svix-timestamp'] || '0') * 1000
  if (Math.abs(Date.now() - ts) > tolerance) return false
  return true  // for full HMAC verification, use svix package
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Parse body
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }

  // Verify it's really from Clerk (basic check — upgrade to svix for production)
  if (!verifyClerkWebhook(body, req.headers)) {
    return res.status(400).json({ error: 'Invalid webhook' })
  }

  const { type, data } = body

  if (type === 'user.created') {
    const { id: clerkId, email_addresses, first_name, last_name } = data
    const email = email_addresses?.[0]?.email_address || ''
    const name  = [first_name, last_name].filter(Boolean).join(' ')

    // Upsert user record in Supabase
    const { error } = await supabase.from('users').upsert({
      clerk_id: clerkId,
      email,
      name,
    }, { onConflict: 'clerk_id' })

    if (error) {
      console.error('Supabase upsert error:', error)
      return res.status(500).json({ error: error.message })
    }

    console.log(`New user created: ${email} (${clerkId})`)
  }

  return res.status(200).json({ received: true })
}
