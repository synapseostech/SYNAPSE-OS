-- 20261102130100_profiles_privileged_column_guard
--
-- `profiles_update_own_or_platform` and `profiles_insert_own_or_platform` let a
-- caller write the row whose id is their own JWT subject. Neither constrains
-- *which columns* are written, and `profiles` carries the columns that decide
-- authorization everywhere else:
--
--   role                 read by is_platform_admin()
--   is_admin             legacy tenant-administrator flag
--   platform_control_role  platform console permission
--   tenant_id            the tenant every policy resolves through
--   is_deleted           account standing
--
-- So any holder of a Supabase-Auth user token could issue
--
--   update profiles set role = 'platform_admin' where id = auth.uid();
--
-- and pass every `is_platform_admin()` bypass in the schema, including the
-- pharmacy policies repaired in 20261102130000. That is the whole cross-tenant
-- model defeated in one statement.
--
-- The application itself does not go through this path: the pharmacy portal and
-- the web app write profiles with the service-role client, and no browser
-- component updates profiles (they read a hospital_id and then query the table
-- they care about). This guard is therefore aimed exactly at the token holder
-- that RLS is supposed to contain.
--
-- Requests without a user JWT are treated as trusted infrastructure and pass
-- through unchanged, so service-role writes, seed scripts and migrations are
-- unaffected. Platform administrators keep the ability to change these columns.
--
-- This file is PREPARED ONLY. It is not applied anywhere by this change.

begin;

create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- No user JWT: the service role, a migration, or a seed script.
  if auth.uid() is null then
    return new;
  end if;

  -- A platform administrator may appoint and suspend others.
  if public.is_platform_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role is distinct from 'clinician'
       or coalesce(new.is_admin, false)
       or new.platform_control_role is not null
       or new.tenant_id is not null
       or coalesce(new.is_deleted, false)
    then
      raise exception
        'PERMISSION: a self-registered profile cannot set role, is_admin, platform_control_role, tenant_id or is_deleted'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.role is distinct from old.role
     or new.is_admin is distinct from old.is_admin
     or new.platform_control_role is distinct from old.platform_control_role
     or new.tenant_id is distinct from old.tenant_id
     or new.is_deleted is distinct from old.is_deleted
     or new.verification_status is distinct from old.verification_status
     or new.hospital_id is distinct from old.hospital_id
     or new.department_id is distinct from old.department_id
  then
    raise exception
      'PERMISSION: only a platform administrator may change an account''s role, standing, tenant or organisation'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function public.profiles_guard_privileged_columns() from public;

drop trigger if exists "profiles_guard_privileged_columns" on public.profiles;

create trigger "profiles_guard_privileged_columns"
  before insert or update on public.profiles
  for each row
  execute function public.profiles_guard_privileged_columns();

-- Self-check: the trigger must be attached, or the guard is dead code.
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and t.tgname = 'profiles_guard_privileged_columns'
      and not t.tgisinternal
  ) then
    raise exception 'the profiles privileged-column guard is not attached';
  end if;
end
$$;

commit;
