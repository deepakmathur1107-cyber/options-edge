// api/stripe/webhook.js
// IMPORTANT: Vercel parses req.body by default which breaks Stripe signature verification.
// The export config below disables body parsing for this route.

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

// Look up clerk_id from stripe_customer_id in Supabase (fallback only)
async function getClerkIdByCustomer(stripeCustomerId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('clerk_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle()
  return data?.clerk_id || null
}

// Resolve clerk_id from multiple sources in priority order:
// 1. Session/subscription metadata (most reliable — set at checkout creation time)
// 2. Supabase lookup by stripe_customer_id (fallback)
async function resolveClerkId(obj) {
  const fromMeta = obj.metadata?.clerk_id
  if (fromMeta) return fromMeta
  const custId = obj.customer
  if (!custId) return null
  return getClerkIdByCustomer(custId)
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Read raw body BEFORE any parsing
  let rawBody
  try {
    rawBody = await getRawBody(req)
  } catch (e) {
    return res.status(400).json({ error: 'Could not read request body' })
  }

  // Verify Stripe signature
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
    return res.status(400).json({ error: 'Webhook signature invalid: ' + e.message })
  }

  console.log('Stripe webhook received:', event.type)

  try {
    switch (event.type) {

      // ── Checkout completed — fires first, immediately after user pays ──────
      // Write subscription row right away so the user isn't locked out while
      // waiting for subscription.created to fire.
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode !== 'subscription') break

        const clerkId = await resolveClerkId(session)
        if (!clerkId) {
          console.error('checkout.session.completed: no clerk_id found for customer', session.customer)
          break
        }

        // subscription.created will overwrite with full details shortly after.
        // We write 'trialing' as a safe default — the actual status comes from
        // subscription.created which fires within seconds.
        await supabase.from('subscriptions').upsert({
          clerk_id:               clerkId,
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          status:                 'trialing',
          plan:                   'pro',
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'clerk_id' })

        console.log(`Checkout completed for clerk_id=${clerkId}, sub=${session.subscription}`)
        break
      }

      // ── Subscription created or updated ───────────────────────────────────
      // Authoritative source for status and current_period_end.
      // Fires after checkout.session.completed and on every status change.
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub       = event.data.object
        const custId    = sub.customer
        const status    = sub.status
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString()

        const clerkId = await resolveClerkId(sub)
        if (!clerkId) {
          console.error(`${event.type}: no clerk_id for customer ${custId}`)
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

        console.log(`Subscription ${event.type} → status=${status} for clerk_id=${clerkId}`)
        break
      }

      // ── Subscription deleted (cancelled and fully ended) ──────────────────
      case 'customer.subscription.deleted': {
        const sub     = event.data.object
        const custId  = sub.customer
        const clerkId = await resolveClerkId(sub)
        if (!clerkId) {
          console.error(`subscription.deleted: no clerk_id for customer ${custId}`)
          break
        }

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

      // ── Invoice payment failed (card decline on renewal) ──────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const clerkId = await getClerkIdByCustomer(invoice.customer)
        if (!clerkId) break

        await supabase.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('clerk_id', clerkId)

        console.log(`Payment failed → past_due for clerk_id=${clerkId}`)
        break
      }

      // ── Invoice payment succeeded (renewal) ───────────────────────────────
      // Skip subscription_create — subscription.created already handles that.
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        if (invoice.billing_reason === 'subscription_create') break

        const clerkId = await getClerkIdByCustomer(invoice.customer)
        if (!clerkId) break

        // On renewal, also update current_period_end from the subscription object
        let periodEnd = null
        if (invoice.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription)
            periodEnd = new Date(sub.current_period_end * 1000).toISOString()
          } catch (e) {
            console.warn('Could not retrieve subscription for period_end update:', e.message)
          }
        }

        const updatePayload = {
          status:     'active',
          updated_at: new Date().toISOString(),
        }
        if (periodEnd) updatePayload.current_period_end = periodEnd

        await supabase.from('subscriptions')
          .update(updatePayload)
          .eq('clerk_id', clerkId)

        console.log(`Payment succeeded → active for clerk_id=${clerkId}`)
        break
      }

      default:
        console.log('Unhandled event type:', event.type)
    }
  } catch (e) {
    console.error('Webhook handler error:', e.message)
    // Return 500 (not 200) on unexpected processing errors so Stripe's
    // built-in retry mechanism gets a chance to recover from a transient
    // failure (e.g. a momentary Supabase outage) — retries persist with
    // backoff for up to 3 days. Returning 200 here would tell Stripe the
    // event was handled when it wasn't, permanently dropping it with no
    // way to recover short of Stripe support manually replaying the event.
    // Deliberate skips (missing clerk_id, wrong session mode, etc.) are
    // handled inside each case via `break` and still return 200 below —
    // those aren't errors, they're legitimate no-ops.
    return res.status(500).json({ received: false, error: e.message })
  }

  return res.status(200).json({ received: true })
}
