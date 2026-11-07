// Supabase Edge Function: receives Stripe "checkout completed" webhooks and
// records each paid book order in the CRM (public.record_order in schema.sql).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY      restricted key with read access to Checkout Sessions
//   STRIPE_WEBHOOK_SECRET  the endpoint's signing secret (whsec_...)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// JWT verification must be OFF for this function: Stripe can't send a Supabase token.

import Stripe from 'npm:stripe@17.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '');
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

const HANDLED = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  // deno-lint-ignore no-explicit-any
  let event: any;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(), signature, webhookSecret, undefined, cryptoProvider,
    );
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  if (!HANDLED.has(event.type)) return new Response('Ignored', { status: 200 });

  const session = event.data.object;
  // Card payments are "paid" on completion; delayed methods arrive later as async_payment_succeeded.
  if (session.payment_status !== 'paid') return new Response('Not paid yet', { status: 200 });

  const email = session.customer_details?.email;
  if (!email) return new Response('No customer email', { status: 200 });

  const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 20 });
  const product = items.data
    .map((i: { description?: string; quantity?: number }) =>
      (i.quantity ?? 1) > 1 ? `${i.description} ×${i.quantity}` : i.description)
    .join(', ') || 'Unknown product';
  const quantity = items.data.reduce((n: number, i: { quantity?: number }) => n + (i.quantity ?? 1), 0);

  // Newer Stripe API versions moved shipping details under collected_information.
  const shipping = session.collected_information?.shipping_details ?? session.shipping_details ?? null;

  const { error } = await db.rpc('record_order', {
    p_session_id: session.id,
    p_email: email,
    p_name: shipping?.name ?? session.customer_details?.name ?? null,
    p_phone: session.customer_details?.phone ?? null,
    p_product: product,
    p_quantity: quantity,
    p_amount_total: session.amount_total ?? 0,
    p_currency: session.currency ?? 'eur',
    p_shipping: shipping?.address ?? session.customer_details?.address ?? null,
  });

  // A non-2xx response makes Stripe retry later; record_order ignores duplicates.
  if (error) {
    console.error('record_order failed', error);
    return new Response('Database error', { status: 500 });
  }
  return new Response('OK', { status: 200 });
});
