-- READ-ONLY. Run after reassign.sql, or after using the /platform/hospitals
-- selector. Keep the output next to the inspect.sql output.
--
-- Proves the chain the application actually depends on:
--   tenant_subscriptions.plan_id -> plan_features -> has_feature()
-- has_feature() is the same gate the TS entitlement layer calls, so this
-- reads exactly what the portal and the mobile API will decide.
--
-- The verdict separates the two independent failures. A tenant whose plan was
-- reassigned but whose row is still past_due or suspended prints
-- "PLAN OK — REACTIVATE": has_feature() opens only the readonly set in those
-- states (20260620223902_subscription_billing_flutterwave.sql:229), so
-- reactivation is still required from /platform/billing.
--
-- Overrides are read before status (same file, line 194), so an enabled
-- override raises granted_features even on a suspended tenant. enabled_overrides
-- is shown so a PARTIAL row can be attributed to an override rather than a gap.

with base as (
  select
    t.id                                    as tenant_id,
    t.slug                                  as tenant_slug,
    t.name                                  as tenant_name,
    sp.slug                                 as plan_slug,
    ts.status,
    ts.trial_ends,
    ts.grace_until,
    (
      select count(*)
      from public.plan_features pf
      where pf.plan_id = ts.plan_id
    )                                       as plan_features,
    (
      select count(*)
      from public.plan_features pf
      where pf.plan_id = ts.plan_id
        and public.has_feature(ts.tenant_id, pf.feature_key)
    )                                       as granted_features,
    (
      select count(*)
      from public.tenant_feature_overrides o
      where o.tenant_id = ts.tenant_id
        and o.enabled
    )                                       as enabled_overrides
  from public.tenant_subscriptions ts
  join public.subscription_plans sp on sp.id = ts.plan_id
  join public.tenants t on t.id = ts.tenant_id
  -- Optional: restrict to the tenants from inspect.sql.
  -- where t.id in ('00000000-0000-0000-0000-000000000000'::uuid)
)
select
  tenant_id,
  tenant_slug,
  tenant_name,
  plan_slug,
  status,
  trial_ends,
  grace_until,
  plan_features,
  granted_features,
  enabled_overrides,
  case
    when plan_slug like 'hospital\_%'
      then 'LEGACY — reassign'
    when plan_features = 0
      then 'NO FEATURES — plan grants nothing'
    when status in ('active', 'trial', 'trialing')
      or (status = 'past_due' and grace_until is not null and now() < grace_until)
      then case
        when granted_features = plan_features then 'ENTITLED'
        else 'PARTIAL — check overrides'
      end
    else 'PLAN OK — REACTIVATE (status ' || status || ')'
  end                                       as verdict
from base
order by verdict, tenant_slug;

-- Expected after a correct reassignment plus reactivation: every row reads
-- ENTITLED, with plan_features matching the seed counts
-- (synapse_lab_annual 4, synapse_os_basic_annual 5,
--  synapse_os_lab_addon_annual 6, synapse_pharmacy_annual 10).
--
-- Rows still on hospital_* mean a decision was missed in reassign.sql.
-- Rows reading "PLAN OK — REACTIVATE" mean the plan moved and the status did
-- not, which is expected until the platform reactivate action is run.
