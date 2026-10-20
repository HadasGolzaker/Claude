-- Run this once in Supabase → SQL Editor → New query → Run.
-- It adds "writer sharing": the owner of a profile can share that one
-- profile with someone else's email, and remove the share at any time.
-- The person it is shared with can read ONLY the profiles shared with
-- their email — nothing else of the owner's data.

create table if not exists public.profile_shares (
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_email text,
  profile_id  text not null,
  profile     text,          -- copy of the profile (name, country, language, profile JSON)
  email       text not null check (email = lower(email)),
  created_at  timestamptz not null default now(),
  primary key (owner_id, profile_id, email)
);

alter table public.profile_shares enable row level security;

drop policy if exists "owner manages shares" on public.profile_shares;
create policy "owner manages shares"
  on public.profile_shares for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "recipient reads shared profile" on public.profile_shares;
create policy "recipient reads shared profile"
  on public.profile_shares for select
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
