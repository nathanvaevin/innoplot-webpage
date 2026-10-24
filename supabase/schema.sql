-- InnoPlot Library CRM: database schema.
-- Run once in Supabase → SQL Editor → New query → paste → Run.
--
-- Model:
--   contacts    one row per unique email address (the CRM record)
--   downloads   one row per resource download, linked to a contact
--   crm_admins  email addresses allowed to log in to /crm.html and read the data
--
-- Security: the public website never touches the tables directly. It can only
-- call capture_lead(), which validates input and writes one contact + download.
-- Reading and editing requires a logged-in user whose email is in crm_admins.

create extension if not exists citext;

-- ---------------------------------------------------------------- tables

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
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
  source_page text,
  created_at  timestamptz not null default now()
);

create index downloads_contact_id_idx on public.downloads (contact_id);
create index downloads_created_at_idx on public.downloads (created_at desc);
create index contacts_last_seen_idx   on public.contacts (last_seen_at desc);

create table public.crm_admins (
  email    citext primary key,
  added_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- access control

alter table public.contacts   enable row level security;
alter table public.downloads  enable row level security;
alter table public.crm_admins enable row level security;

-- Anonymous visitors get no direct table access at all.
revoke all on public.contacts, public.downloads, public.crm_admins from anon;

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

create policy "admins read contacts"   on public.contacts  for select to authenticated using (public.is_crm_admin());
create policy "admins update contacts" on public.contacts  for update to authenticated using (public.is_crm_admin()) with check (public.is_crm_admin());
create policy "admins delete contacts" on public.contacts  for delete to authenticated using (public.is_crm_admin());
create policy "admins read downloads"  on public.downloads for select to authenticated using (public.is_crm_admin());
create policy "admins read admins"     on public.crm_admins for select to authenticated using (public.is_crm_admin());

-- ---------------------------------------------------------------- public entry point

-- Called by the website's download form. Creates the contact on first visit,
-- refreshes last_seen_at on later visits, and always logs the download.
create function public.capture_lead(
  p_email       text,
  p_resource    text,
  p_source_page text    default null,
  p_consent     boolean default false
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
  if not coalesce(p_consent, false) then
    raise exception 'consent required';
  end if;

  insert into public.contacts (email, consent)
  values (lower(trim(p_email)), true)
  on conflict (email) do update
    set last_seen_at = now(), consent = true
  returning id into v_contact_id;

  insert into public.downloads (contact_id, resource, source_page)
  values (v_contact_id, p_resource, left(p_source_page, 200));
end;
$$;

revoke all on function public.capture_lead(text, text, text, boolean) from public;
grant execute on function public.capture_lead(text, text, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------- who can log in

-- Replace these with the real addresses, then run. Each person also needs a
-- login: Authentication → Users → Add user (use the same email).
insert into public.crm_admins (email) values
  ('REPLACE_WITH_YOUR_EMAIL'),
  ('REPLACE_WITH_KOENS_EMAIL');
