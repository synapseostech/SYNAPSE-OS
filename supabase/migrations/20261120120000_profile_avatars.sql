-- 20261120120000_profile_avatars
--
-- Profile pictures for app users and pharmacy staff.
--
--   storage bucket profile-avatars   private; 2 MB per object; JPEG/PNG/WebP only
--   profiles.avatar_path             the current picture's object path in that bucket
--   profiles.avatar_updated_at       when it last changed (cache-busting, audit)
--
-- Object paths are scoped by tenant and then by user:
--
--   <tenant_id | 'personal'>/<profile_id>/<timestamp>.jpg
--
-- The app never talks to Storage with a user JWT: POST /api/mobile/profile/avatar
-- (web, service role) checks the Synapse session, signs a one-time upload URL
-- for exactly that path, then records it here and signs short-lived read URLs.
-- The policies below are defence in depth for any client that does hold a
-- Supabase user session: a user may read pictures inside their own tenant (and
-- their own), and may write only under their own <tenant>/<user> folder.
--
-- profiles.avatar_path and avatar_updated_at are NOT in the self-service
-- allow-list of profiles_guard_privileged_columns (20261003160000), so API
-- roles cannot point their profile at another user's object; only the server
-- writes them.
--
-- PREPARED ONLY: written for review. It has not been applied to any database
-- by this change; the owner applies it.

begin;

-- 1. Columns -------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_path text
    check (avatar_path is null or avatar_path ~ '^[0-9a-z-]{1,64}/[0-9a-f-]{36}/[0-9]{10,16}\.(jpg|png|webp)$'),
  add column if not exists avatar_updated_at timestamptz;

comment on column public.profiles.avatar_path is
  'Object path in the private profile-avatars bucket (<tenant|personal>/<profile id>/<ts>.jpg). Written by the server only.';

-- 2. Bucket --------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 3. Storage RLS ---------------------------------------------------------------
-- Folder 1 is the tenant (or 'personal'), folder 2 the owning profile id.
drop policy if exists profile_avatars_read_same_tenant on storage.objects;
create policy profile_avatars_read_same_tenant
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or (storage.foldername(name))[1] = (select public.current_tenant_id())::text
    )
  );

drop policy if exists profile_avatars_insert_own on storage.objects;
create policy profile_avatars_insert_own
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (storage.foldername(name))[1] = coalesce((select public.current_tenant_id())::text, 'personal')
  );

drop policy if exists profile_avatars_update_own on storage.objects;
create policy profile_avatars_update_own
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (storage.foldername(name))[1] = coalesce((select public.current_tenant_id())::text, 'personal')
  );

drop policy if exists profile_avatars_delete_own on storage.objects;
create policy profile_avatars_delete_own
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- anon gets nothing: no policy names it, and the bucket is private.

commit;
