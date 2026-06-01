// api/stripe/webhook.js
// Stripe sends events here when subscriptions change.
// This is the source of truth — it updates Supabase and Clerk metadata.
//
// Add this URL in Stripe Dashboard → Developers → Webhooks:
//   https://your-app.vercel.app/api/stripe/webhook
// Events to enable:
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed
//   invoice.payment_succeeded

const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const { createClerkClient } = require('@clerk/backend')

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const clerk    = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })

// Vercel doesn't parse raw body for webhooks — we need raw bytes for Stripe signature
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Get raw body for signature verification
  const sig       = req.headers['stripe-signature']
  const rawBody   = req.body   // Vercel passes as Buffer when bodyParser is disabled

  let event
  try {
    event = stripe.webhooks.constructEvent(
      typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (e) {
    console.error('Webhook signature failed:', e.message)
    return res.status(400).json({ error: 'Invalid signature' })
  }

  console.log('Stripe webhook:', event.type)

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub       = event.data.object
        const clerkId   = sub.metadata?.clerk_id
        const custId    = sub.customer
        const status    = sub.status  // active | trialing | past_due | cancelled | etc.
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString()

        if (!clerkId) {
          // Look up clerk_id from customer metadata in Supabase
          const { data } = await supabase
            .from('subscriptions')
            .select('clerk_id')
            .eq('stripe_customer_id', custId)
            .maybeSingle()
          if (!data?.clerk_id) break
        }

        const resolvedClerkId = clerkId || await getClerkIdFromCustomer(custId)
        if (!resolvedClerkId) break

        await supabase.from('subscriptions').upsert({
          clerk_id:               resolvedClerkId,
          stripe_customer_id:     custId,
          stripe_subscription_id: sub.id,
          status,
          plan:                   'pro',
          current_period_end:     periodEnd,
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })

        // Update Clerk user metadata for fast frontend checks
        await clerk.users.updateUserMetadata(resolvedClerkId, {
          publicMetadata: { subscriptionStatus: status, plan: 'pro' }
        }).catch(e => console.error('Clerk metadata update failed:', e))

        console.log(`Sub ${status} for ${resolvedClerkId}, period ends ${periodEnd}`)
        break
      }

      case 'customer.subscription.deleted': {
        const sub       = event.data.object
        const custId    = sub.customer
        const clerkId   = sub.metadata?.clerk_id || await getClerkIdFromCustomer(custId)
        if (!clerkId) break

        await supabase.from('subscriptions').upsert({
          clerk_id:               clerkId,
          stripe_customer_id:     custId,
          stripe_subscription_id: sub.id,
          status:                 'cancelled',
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })

        await clerk.users.updateUserMetadata(clerkId, {
          publicMetadata: { subscriptionStatus: 'cancelled', plan: null }
        }).catch(e => console.error('Clerk metadata update failed:', e))

        console.log(`Sub cancelled for ${clerkId}`)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const custId  = invoice.customer
        const clerkId = await getClerkIdFromCustomer(custId)
        if (!clerkId) break

        await supabase.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('clerk_id', clerkId)

        await clerk.users.updateUserMetadata(clerkId, {
          publicMetadata: { subscriptionStatus: 'past_due' }
        }).catch(e => console.error('Clerk metadata update failed:', e))

        console.log(`Payment failed for ${clerkId}`)
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        if (invoice.billing_reason === 'subscription_create') break  // handled above
        const custId  = invoice.customer
        const clerkId = await getClerkIdFromCustomer(custId)
        if (!clerkId) break

        await supabase.from('subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('clerk_id', clerkId)

        console.log(`Payment succeeded for ${clerkId}`)
        break
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e)
    return res.status(500).json({ error: e.message })
  }

  return res.status(200).json({ received: true })
}

// Helper — look up clerk_id from stripe_customer_id via Supabase
async function getClerkIdFromCustomer(stripeCustomerId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('clerk_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle()
  return data?.clerk_id || null
}
