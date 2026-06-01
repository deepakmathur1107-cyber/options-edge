// api/stripe/webhook.js
// IMPORTANT: Vercel parses req.body by default which breaks Stripe signature verification.
// The export config below disables body parsing for this route.

// Disable Vercel's automatic body parsing — Stripe needs the raw body
module.exports.config = {
  api: { bodyParser: false }
}

const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Read raw body from request stream — required for Stripe signature verification
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end',  ()    => resolve(data))
    req.on('error', err  => reject(err))
  })
}

// Look up clerk_id from stripe_customer_id in Supabase
async function getClerkId(stripeCustomerId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('clerk_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle()
  return data?.clerk_id || null
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Read raw body BEFORE Vercel/Express can parse it
  let rawBody
  try {
    rawBody = await getRawBody(req)
  } catch (e) {
    return res.status(400).json({ error: 'Could not read request body' })
  }

  // Verify Stripe signature using raw body
  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (e) {
    console.error('Stripe signature verification failed:', e.message)
    console.error('  sig header:', sig?.substring(0, 40))
    console.error('  secret set:', !!process.env.STRIPE_WEBHOOK_SECRET)
    return res.status(400).json({ error: 'Webhook signature invalid: ' + e.message })
  }

  console.log('Stripe webhook received:', event.type)

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub     = event.data.object
        const custId  = sub.customer
        const status  = sub.status
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString()

        // Get clerk_id from subscription metadata or look up from Supabase
        const clerkId = sub.metadata?.clerk_id || await getClerkId(custId)
        if (!clerkId) {
          console.error('No clerk_id for customer:', custId)
          break
        }

        await supabase.from('subscriptions').upsert({
          clerk_id:               clerkId,
          stripe_customer_id:     custId,
          stripe_subscription_id: sub.id,
          status,
          plan:                   'pro',
          current_period_end:     periodEnd,
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })

        console.log(`Subscription ${status} for clerk_id=${clerkId}`)
        break
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object
        const custId = sub.customer
        const clerkId = sub.metadata?.clerk_id || await getClerkId(custId)
        if (!clerkId) break

        await supabase.from('subscriptions').upsert({
          clerk_id:               clerkId,
          stripe_customer_id:     custId,
          stripe_subscription_id: sub.id,
          status:                 'cancelled',
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })

        console.log(`Subscription cancelled for clerk_id=${clerkId}`)
        break
      }

      case 'invoice.payment_failed': {
        const custId  = event.data.object.customer
        const clerkId = await getClerkId(custId)
        if (!clerkId) break
        await supabase.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('clerk_id', clerkId)
        console.log(`Payment failed for clerk_id=${clerkId}`)
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        if (invoice.billing_reason === 'subscription_create') break
        const clerkId = await getClerkId(invoice.customer)
        if (!clerkId) break
        await supabase.from('subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('clerk_id', clerkId)
        console.log(`Payment succeeded for clerk_id=${clerkId}`)
        break
      }

      default:
        console.log('Unhandled event type:', event.type)
    }
  } catch (e) {
    console.error('Webhook handler error:', e.message)
    // Still return 200 so Stripe doesn't retry — log the error instead
    return res.status(200).json({ received: true, warning: e.message })
  }

  return res.status(200).json({ received: true })
}
