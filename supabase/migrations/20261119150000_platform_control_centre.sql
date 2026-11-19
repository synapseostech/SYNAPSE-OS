-- 20261119150000_platform_control_centre
--
-- Read-only views of the whole system for the platform console
-- (admin.synapseos.tech): one row per tenant with its usage, and the free-tier
-- figures that decide whether the project keeps running on the free plan.
--
--   platform_tenant_overview()    one row per tenant: type, plan, status,
--                                 users, last sign-in, storage used, and the
--                                 latest Tally import (pharmacy_import_sessions)
--   platform_system_usage()       database size against the 500 MB free-plan
--                                 limit, storage per bucket, largest tables,
--                                 open connections
--   platform_slow_queries(int)    the slowest statements by mean time from
--                                 pg_stat_statements (already installed);
--                                 constants are normalised away by the extension
--
-- Each function only reads, is SECURITY DEFINER with an empty search_path,
-- and is executable by service_role alone: anon and authenticated hold no
-- privilege, so none of this is reachable from a browser or an app session.
-- The console calls them through the server's service client after its own
-- capability check (tenant.read / system_health.read).
--
-- No tables are created, so there is no new RLS surface.
--
-- PREPARED ONLY: written for review. It has not been applied to any database
-- by this change; the owner applies it.

begin;

create or replace function public.platform_tenant_overview()
returns table (
  tenant_id            uuid,
  name                 text,
  slug                 text,
  facility_type        text,
  plan                 text,
  tier                 text,
  status               text,
  lifecycle_status     text,
  is_active            boolean,
  is_synthetic         boolean,
  environment          text,
  onboarding_completed boolean,
  onboarding_step      integer,
  created_at           timestamptz,
  user_count           bigint,
  last_activity_at     timestamptz,
  storage_bytes        bigint,
  storage_objects      bigint,
  import_count         bigint,
  last_import_status   text,
  last_import_at       timestamptz,
  last_import_file     text,
  last_import_error    text
)
language sql
stable
security definer
set search_path = ''
as $$
  with users as (
    select p.tenant_id, count(*) as user_count, max(p.last_sign_in_at) as last_activity_at
    from public.profiles p
    where p.tenant_id is not null
    group by p.tenant_id
  ),
  files as (
    -- Tenant files are stored under tenants/<tenant id>/... in every bucket.
    select (regexp_match(o.name, '^tenants/([0-9a-f-]{36})/'))[1]::uuid as tenant_id,
           coalesce(sum((o.metadata->>'size')::bigint), 0) as storage_bytes,
           count(*) as storage_objects
    from storage.objects o
    where o.name ~ '^tenants/[0-9a-f-]{36}/'
    group by 1
  ),
  imports as (
    select i.tenant_id, count(*) as import_count
    from public.pharmacy_import_sessions i
    group by i.tenant_id
  ),
  last_import as (
    select distinct on (i.tenant_id)
           i.tenant_id, i.status, i.created_at, i.file_name, i.error_message
    from public.pharmacy_import_sessions i
    order by i.tenant_id, i.created_at desc
  )
  select t.id, t.name, t.slug, t.facility_type, t.plan, t.tier, t.status,
         t.lifecycle_status, t.is_active, coalesce(t.is_synthetic, false),
         t.environment, t.onboarding_completed, t.onboarding_step, t.created_at,
         coalesce(u.user_count, 0), u.last_activity_at,
         coalesce(f.storage_bytes, 0), coalesce(f.storage_objects, 0),
         coalesce(im.import_count, 0), li.status, li.created_at,
         li.file_name, left(li.error_message, 300)
  from public.tenants t
  left join users u on u.tenant_id = t.id
  left join files f on f.tenant_id = t.id
  left join imports im on im.tenant_id = t.id
  left join last_import li on li.tenant_id = t.id
  order by t.created_at desc;
$$;

create or replace function public.platform_system_usage()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'database_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'storage', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b.bucket_id, 'objects', b.objects, 'bytes', b.bytes) order by b.bytes desc)
      from (
        select o.bucket_id, count(*) as objects, coalesce(sum((o.metadata->>'size')::bigint), 0) as bytes
        from storage.objects o
        group by o.bucket_id
      ) b
    ), '[]'::jsonb),
    'largest_tables', coalesce((
      select jsonb_agg(jsonb_build_object('table', t.relname, 'bytes', t.bytes, 'rows', t.rows) order by t.bytes desc)
      from (
        select c.relname, pg_catalog.pg_total_relation_size(c.oid) as bytes, c.reltuples::bigint as rows
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by pg_catalog.pg_total_relation_size(c.oid) desc
        limit 10
      ) t
    ), '[]'::jsonb),
    'connections', (select count(*) from pg_catalog.pg_stat_activity where datname = pg_catalog.current_database()),
    'measured_at', now()
  );
$$;

create or replace function public.platform_slow_queries(p_limit integer default 10)
returns table (
  query       text,
  calls       bigint,
  mean_ms     double precision,
  total_ms    double precision,
  rows        bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select left(s.query, 300), s.calls, round(s.mean_exec_time::numeric, 2)::double precision,
         round(s.total_exec_time::numeric, 2)::double precision, s.rows
  from extensions.pg_stat_statements s
  where s.dbid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
    and s.calls > 0
    -- Only the app's own traffic: the Supabase dashboard's introspection runs
    -- as postgres/supabase_admin and would otherwise fill the list.
    and s.userid in (
      select r.oid from pg_catalog.pg_roles r
      where r.rolname in ('authenticator', 'authenticated', 'anon', 'service_role')
    )
    and s.query !~* '^\s*(begin|commit|rollback|set |show |deallocate)'
  order by s.mean_exec_time desc
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

revoke all on function public.platform_tenant_overview() from public, anon, authenticated;
revoke all on function public.platform_system_usage() from public, anon, authenticated;
revoke all on function public.platform_slow_queries(integer) from public, anon, authenticated;

grant execute on function public.platform_tenant_overview() to service_role;
grant execute on function public.platform_system_usage() to service_role;
grant execute on function public.platform_slow_queries(integer) to service_role;

commit;
