-- Run this once in Supabase Dashboard > SQL Editor > New query.
-- Each account owns exactly one private collection snapshot.

create table if not exists public.anki_collections (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  snapshot_path text not null,
  version bigint not null,
  size_bytes bigint not null constraint anki_collections_size_bytes_check check (size_bytes > 0 and size_bytes <= 524288000),
  part_count integer not null constraint anki_collections_part_count_check check (part_count >= 1 and part_count <= 100),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint anki_collections_snapshot_path_check check (snapshot_path like (owner_id::text || '/%'))
);

alter table public.anki_collections enable row level security;

drop policy if exists "Users can read their own Anki snapshot metadata" on public.anki_collections;
create policy "Users can read their own Anki snapshot metadata"
  on public.anki_collections for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users can create their own Anki snapshot metadata" on public.anki_collections;
create policy "Users can create their own Anki snapshot metadata"
  on public.anki_collections for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can update their own Anki snapshot metadata" on public.anki_collections;
create policy "Users can update their own Anki snapshot metadata"
  on public.anki_collections for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can delete their own Anki snapshot metadata" on public.anki_collections;
create policy "Users can delete their own Anki snapshot metadata"
  on public.anki_collections for delete to authenticated
  using ((select auth.uid()) = owner_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('anki-sync', 'anki-sync', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "Users can read their own Anki snapshots" on storage.objects;
create policy "Users can read their own Anki snapshots"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'anki-sync'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users can upload their own Anki snapshots" on storage.objects;
create policy "Users can upload their own Anki snapshots"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'anki-sync'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users can replace their own Anki snapshots" on storage.objects;
create policy "Users can replace their own Anki snapshots"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'anki-sync'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'anki-sync'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users can delete their own Anki snapshots" on storage.objects;
create policy "Users can delete their own Anki snapshots"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'anki-sync'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
