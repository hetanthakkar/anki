-- Run this after 20260907_add_anki_snapshot_sync.sql if you have already run it.
-- Supabase Free permits 50 MiB per object, so snapshots are stored in 5 MiB parts.

alter table public.anki_collections
  add column if not exists part_count integer not null default 1;

alter table public.anki_collections
  drop constraint if exists anki_collections_size_bytes_check,
  add constraint anki_collections_size_bytes_check check (size_bytes > 0 and size_bytes <= 524288000),
  drop constraint if exists anki_collections_part_count_check,
  add constraint anki_collections_part_count_check check (part_count >= 1 and part_count <= 100),
  drop constraint if exists anki_collections_check,
  drop constraint if exists anki_collections_snapshot_path_check,
  add constraint anki_collections_snapshot_path_check check (snapshot_path like (owner_id::text || '/%'));

update storage.buckets
  set public = false, file_size_limit = 52428800
  where id = 'anki-sync';

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
