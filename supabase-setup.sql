-- Run this once in Supabase → SQL Editor → New query → Run.
-- It creates the table that stores each user's profile and post history,
-- and locks it so every user can only see and change their own data.

create table if not exists public.kv_store (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.kv_store enable row level security;

create policy "own rows - select"
  on public.kv_store for select
  using (auth.uid() = user_id);

create policy "own rows - insert"
  on public.kv_store for insert
  with check (auth.uid() = user_id);

create policy "own rows - update"
  on public.kv_store for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
