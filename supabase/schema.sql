-- InnoPlot Library: database schema for visitor accounts, downloads, orders and the CRM.
-- Run once in Supabase → SQL Editor → New query → paste → Run.
--
-- Model:
--   contacts    one row per unique email address (the CRM record)
--   downloads   one row per resource download, linked to a contact
--   orders      one row per paid Stripe checkout, linked to a contact
--   crm_admins  email addresses allowed into /crm.html
--
-- Who can do what:
--   anonymous visitors  only capture_lead() (the download form)
--   signed-in visitors  read their own contact, downloads and orders (/account.html)
--   CRM admins          read and edit everything (/crm.html)
--   Stripe webhook      record_order(), via the service role key (server-side only)

create extension if not exists citext;

-- ---------------------------------------------------------------- tables

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  user_id       uuid references auth.users (id) on delete set null,
  name          text,
  company       text,
  status        text not null default 'new'
                check (status in ('new', 'contacted', 'qualified', 'customer', 'archived')),
  notes         text,
  consent       boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table public.downloads (
  id          bigint generated always as identity primary key,
  contact_id  uuid not null references public.contacts (id) on delete cascade,
  resource    text not null,
  file        text,
  source_page text,
  created_at  timestamptz not null default now()
);

create table public.orders (
  id                bigint generated always as identity primary key,
  contact_id        uuid not null references public.contacts (id) on delete cascade,
  stripe_session_id text not null unique,
  product           text not null,
  quantity          integer not null default 1,
  amount_total      integer not null,           -- in cents
  currency          text not null default 'eur',
  status            text not null default 'paid' check (status in ('paid', 'shipped', 'cancelled')),
  customer_name     text,
  phone             text,
  shipping          jsonb,                      -- Stripe address object
  created_at        timestamptz not null default now(),
  shipped_at        timestamptz
);

create table public.crm_admins (
  email    citext primary key,
  added_at timestamptz not null default now()
);

create index contacts_user_id_idx     on public.contacts (user_id);
create index contacts_last_seen_idx   on public.contacts (last_seen_at desc);
create index downloads_contact_id_idx on public.downloads (contact_id);
create index downloads_created_at_idx on public.downloads (created_at desc);
create index orders_contact_id_idx    on public.orders (contact_id);
create index orders_created_at_idx    on public.orders (created_at desc);

-- ---------------------------------------------------------------- access control

alter table public.contacts   enable row level security;
alter table public.downloads  enable row level security;
alter table public.orders     enable row level security;
alter table public.crm_admins enable row level security;

revoke all on public.contacts, public.downloads, public.orders, public.crm_admins from anon, authenticated;
grant select, update, delete on public.contacts   to authenticated;
grant select                 on public.downloads  to authenticated;
grant select, update         on public.orders     to authenticated;
grant select                 on public.crm_admins to authenticated;

-- Relies on "Confirm email" being ON in Supabase Auth, so the email in a
-- session token is always one the person has proven they own.
create function public.is_crm_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.crm_admins
    where email = (auth.jwt() ->> 'email')
  );
$$;

revoke all on function public.is_crm_admin() from public;
grant execute on function public.is_crm_admin() to authenticated;

-- Admins: everything.
create policy "admins read contacts"   on public.contacts   for select to authenticated using (public.is_crm_admin());
create policy "admins update contacts" on public.contacts   for update to authenticated using (public.is_crm_admin()) with check (public.is_crm_admin());
create policy "admins delete contacts" on public.contacts   for delete to authenticated using (public.is_crm_admin());
create policy "admins read downloads"  on public.downloads  for select to authenticated using (public.is_crm_admin());
create policy "admins read orders"     on public.orders     for select to authenticated using (public.is_crm_admin());
create policy "admins update orders"   on public.orders     for update to authenticated using (public.is_crm_admin()) with check (public.is_crm_admin());
create policy "admins read admins"     on public.crm_admins for select to authenticated using (public.is_crm_admin());

-- Visitors: only their own records.
create policy "own contact"   on public.contacts  for select to authenticated using (user_id = auth.uid());
create policy "own downloads" on public.downloads for select to authenticated
  using (contact_id in (select id from public.contacts where user_id = auth.uid()));
create policy "own orders"    on public.orders    for select to authenticated
  using (contact_id in (select id from public.contacts where user_id = auth.uid()));

-- ---------------------------------------------------------------- link accounts to contacts

-- When someone's email is confirmed (immediately for Google sign-in), attach
-- their account to the contact with that email, creating it if needed. Earlier
-- downloads and orders under that email then appear in their library.
create function public.link_auth_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;

  insert into public.contacts (email, user_id, name)
  values (
    lower(new.email),
    new.id,
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), '')
  )
  on conflict (email) do update
    set user_id      = excluded.user_id,
        name         = coalesce(public.contacts.name, excluded.name),
        last_seen_at = now();
  return new;
exception when others then
  -- Never block a sign-up because of CRM bookkeeping.
  return new;
end;
$$;

create trigger on_auth_user_confirmed
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.link_auth_user();

-- ---------------------------------------------------------------- download form

-- Called by the website's download form. Creates the contact on first visit,
-- refreshes last_seen_at on later visits, and always logs the download.
create function public.capture_lead(
  p_email       text,
  p_resource    text,
  p_source_page text    default null,
  p_consent     boolean default false,
  p_file        text    default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
begin
  if p_email is null
     or length(p_email) > 254
     or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email';
  end if;
  if p_resource is null or length(p_resource) = 0 or length(p_resource) > 200 then
    raise exception 'invalid resource';
  end if;
  if p_file is not null and (p_file !~ '^assets/whitepapers/[A-Za-z0-9_.-]+\.pdf$' or p_file like '%..%') then
    raise exception 'invalid file';
  end if;
  if not coalesce(p_consent, false) then
    raise exception 'consent required';
  end if;

  insert into public.contacts (email, consent)
  values (lower(trim(p_email)), true)
  on conflict (email) do update
    set last_seen_at = now(), consent = true
  returning id into v_contact_id;

  insert into public.downloads (contact_id, resource, file, source_page)
  values (v_contact_id, p_resource, p_file, left(p_source_page, 200));
end;
$$;

revoke all on function public.capture_lead(text, text, text, boolean, text) from public;
grant execute on function public.capture_lead(text, text, text, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------- Stripe orders

-- Called only by the stripe-webhook Edge Function (service role). Safe to call
-- twice for the same checkout: Stripe retries webhooks, duplicates are ignored.
create function public.record_order(
  p_session_id    text,
  p_email         text,
  p_name          text,
  p_phone         text,
  p_product       text,
  p_quantity      integer,
  p_amount_total  integer,
  p_currency      text,
  p_shipping      jsonb
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
begin
  insert into public.contacts (email, name, status)
  values (lower(trim(p_email)), nullif(p_name, ''), 'customer')
  on conflict (email) do update
    set last_seen_at = now(),
        name         = coalesce(public.contacts.name, excluded.name),
        status       = case when public.contacts.status = 'archived' then 'archived' else 'customer' end
  returning id into v_contact_id;

  insert into public.orders
    (contact_id, stripe_session_id, product, quantity, amount_total, currency, customer_name, phone, shipping)
  values
    (v_contact_id, p_session_id, p_product, coalesce(p_quantity, 1), p_amount_total,
     lower(coalesce(p_currency, 'eur')), nullif(p_name, ''), nullif(p_phone, ''), p_shipping)
  on conflict (stripe_session_id) do nothing;
end;
$$;

revoke all on function public.record_order(text, text, text, text, text, integer, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_order(text, text, text, text, text, integer, integer, text, jsonb) to service_role;

-- ---------------------------------------------------------------- CRM access

-- Replace these with the real addresses, then run. Each person then signs in
-- at /crm.html with Google, or creates an account with that email at /account.html.
insert into public.crm_admins (email) values
  ('nathanvaevin@gmail.com'),
  ('koen@innoplot.nl');
