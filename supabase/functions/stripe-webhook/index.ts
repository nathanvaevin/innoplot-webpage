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

  // The order is saved; a failed email must never make Stripe retry the whole webhook.
  try {
    await notifyTeam({
      product,
      amount: session.amount_total ?? 0,
      currency: session.currency ?? 'eur',
      email,
      name: shipping?.name ?? session.customer_details?.name ?? '',
      phone: session.customer_details?.phone ?? '',
      address: shipping?.address ?? session.customer_details?.address ?? null,
    });
  } catch (e) {
    console.error('order email failed', e);
  }
  return new Response('OK', { status: 200 });
});

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// Emails the team through Resend. Skipped silently until RESEND_API_KEY is set.
async function notifyTeam(o: {
  product: string; amount: number; currency: string; email: string; name: string; phone: string;
  // deno-lint-ignore no-explicit-any
  address: any;
}) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return;
  const to = (Deno.env.get('ORDER_NOTIFY_TO') ?? 'koen@innoplot.nl').split(',').map((s) => s.trim()).filter(Boolean);
  const price = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: o.currency.toUpperCase() }).format(o.amount / 100);
  const a = o.address ?? {};
  const addressLines = [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.state, a.country].filter(Boolean);

  const text = [
    `New order: ${o.product}`, `Amount paid: ${price}`, '',
    'Ship to:', o.name, ...addressLines, '',
    `Email: ${o.email}`, o.phone ? `Phone: ${o.phone}` : '', '',
    'Mark it as shipped in the CRM: https://www.innoplotlibrary.com/crm.html',
  ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#1a2530">
<h2 style="font-size:20px;margin:0 0 4px">New order: ${esc(o.product)}</h2>
<p style="margin:0 0 16px;color:#5a6b7a">Paid ${esc(price)}</p>
<p style="margin:0 0 4px"><b>Ship to</b></p>
<p style="margin:0 0 16px">${[o.name, ...addressLines].filter(Boolean).map(esc).join('<br>')}</p>
<p style="margin:0 0 16px">${esc(o.email)}${o.phone ? '<br>' + esc(o.phone) : ''}</p>
<p style="margin:0"><a href="https://www.innoplotlibrary.com/crm.html">Open the CRM</a> to mark it as shipped.</p></div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('ORDER_NOTIFY_FROM') ?? 'InnoPlot Library <orders@innoplotlibrary.com>',
      to, reply_to: o.email, subject: `New order: ${o.product}`, text, html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
