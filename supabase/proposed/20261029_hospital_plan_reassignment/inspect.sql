-- READ-ONLY. Run this first and keep the output: it is the rollback source.
--
-- Shows every tenant still pointing at a legacy hospital_* plan, which has
-- zero plan_features by design (20260716104338_hospital_module_registry_seed
-- line 7: "FLAG-OFF: no plan_features for hospital plans"). Also shows status
-- and trial clock, because a plan change does not reactivate a suspended row.

select
  t.id                                as tenant_id,
  t.slug                              as tenant_slug,
  t.name                              as tenant_name,
  sp.slug                             as current_plan,
  sp.id                               as current_plan_id,
  ts.status,
  ts.trial_ends,
  ts.grace_until,
  ts.current_period_end,
  (
    select count(*)
    from public.tenant_feature_overrides o
    where o.tenant_id = ts.tenant_id
      and o.enabled
  )                                   as enabled_overrides
from public.tenant_subscriptions ts
join public.subscription_plans sp on sp.id = ts.plan_id
join public.tenants t on t.id = ts.tenant_id
where sp.slug like 'hospital\_%'
order by ts.status, t.slug;

-- Feature rows now behind each commercial plan (after the 20261029 seed):
--
--   select sp.slug, count(pf.feature_key) as features
--   from public.subscription_plans sp
--   left join public.plan_features pf on pf.plan_id = sp.id
--   where sp.slug like 'synapse\_%'
--   group by sp.slug order by sp.slug;
--
-- Expected: synapse_lab_annual 4, synapse_os_basic_annual 5,
-- synapse_os_lab_addon_annual 6, synapse_pharmacy_annual 10,
-- synapse_enterprise 0.
