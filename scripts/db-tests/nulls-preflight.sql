-- NULL-tenant operator preflight (read-only).
--
-- Run against an authorized target only, with:
--   psql -X -v ON_ERROR_STOP=1 -f scripts/db-tests/nulls-preflight.sql
--
-- READ-ONLY: SELECT statements only. No INSERT, UPDATE, DELETE, ALTER, DROP,
-- CREATE or TRUNCATE anywhere in this file.
--
-- The results determine whether the tenant_isolation repair hides existing
-- rows and whether a backfill is required. No backfill is provided here,
-- because ownership of existing rows must be decided by an operator.

\set ON_ERROR_STOP on

-- 1. NULL-tenant counts per table (the ten repaired by the tenant-isolation
--    migration).
select 'encounter_orders' as table_name,
       count(*) filter (where tenant_id is null) as null_tenant,
       count(*) as total from public.encounter_orders
union all select 'encounters', count(*) filter (where tenant_id is null), count(*) from public.encounters
union all select 'gas_cylinders', count(*) filter (where tenant_id is null), count(*) from public.gas_cylinders
union all select 'hospital_drug_orders', count(*) filter (where tenant_id is null), count(*) from public.hospital_drug_orders
union all select 'order_items', count(*) filter (where tenant_id is null), count(*) from public.order_items
union all select 'products', count(*) filter (where tenant_id is null), count(*) from public.products
union all select 'sync_conflicts', count(*) filter (where tenant_id is null), count(*) from public.sync_conflicts
union all select 'telemedicine_intake_cases', count(*) filter (where tenant_id is null), count(*) from public.telemedicine_intake_cases
union all select 'telemedicine_intake_messages', count(*) filter (where tenant_id is null), count(*) from public.telemedicine_intake_messages
union all select 'vitals', count(*) filter (where tenant_id is null), count(*) from public.vitals
order by table_name;

-- 2. Orphaned tenancy: rows whose non-null tenant_id has no matching tenants
--    row. The tenant_isolation predicate treats these as simply not-equal, so
--    they are invisible to every tenant but visible to service_role.
select 'products' as table_name, count(*) as orphaned_tenant_rows
from public.products p
where p.tenant_id is not null
  and not exists (select 1 from public.tenants t where t.id = p.tenant_id)
union all
select 'order_items', count(*)
from public.order_items oi
where oi.tenant_id is not null
  and not exists (select 1 from public.tenants t where t.id = oi.tenant_id)
union all
select 'encounters', count(*)
from public.encounters e
where e.tenant_id is not null
  and not exists (select 1 from public.tenants t where t.id = e.tenant_id)
union all
select 'vitals', count(*)
from public.vitals v
where v.tenant_id is not null
  and not exists (select 1 from public.tenants t where t.id = v.tenant_id)
union all
select 'telemedicine_intake_cases', count(*)
from public.telemedicine_intake_cases c
where c.tenant_id is not null
  and not exists (select 1 from public.tenants t where t.id = c.tenant_id)
union all
select 'telemedicine_intake_messages', count(*)
from public.telemedicine_intake_messages m
where m.tenant_id is not null
  and not exists (select 1 from public.tenants t where t.id = m.tenant_id)
order by table_name;

-- 3. Success marker. Emitted only if every statement above completed, because
--    the runner runs this file with -v ON_ERROR_STOP=1. The runner treats a log
--    without this line as a failed run, so an error can never masquerade as a
--    completed preflight.
select 'NULLS_PREFLIGHT_COMPLETE' as preflight_marker;
