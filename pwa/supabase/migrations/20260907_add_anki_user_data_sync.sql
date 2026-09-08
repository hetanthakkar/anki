-- Run this after the Anki collection snapshot migrations.
-- These small JSON documents travel with an explicit cloud upload/download.
-- The collection itself, reviews, and statistics remain in the .colpkg snapshot.

create table if not exists public.anki_user_data (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  saved_searches jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default timezone('utc', now()),
  constraint anki_user_data_preferences_check check (jsonb_typeof(preferences) = 'object'),
  constraint anki_user_data_saved_searches_check check (jsonb_typeof(saved_searches) = 'array')
);

alter table public.anki_user_data enable row level security;

drop policy if exists "Users can read their own Anki user data" on public.anki_user_data;
create policy "Users can read their own Anki user data"
  on public.anki_user_data for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users can create their own Anki user data" on public.anki_user_data;
create policy "Users can create their own Anki user data"
  on public.anki_user_data for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can update their own Anki user data" on public.anki_user_data;
create policy "Users can update their own Anki user data"
  on public.anki_user_data for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
