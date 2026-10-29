-- PREPARED — not executed. Reverts reassign.sql for the tenants listed below.
--
-- Take previous_plan_slug from the current_plan column of inspect.sql, not
-- from memory: a tenant moved off hospital_professional must go back to
-- hospital_professional, not to hospital_starter.
--
-- The guard makes this a no-op for any tenant whose plan no longer matches
-- the commercial plan it was moved to, so re-running it is harmless.

with revert(tenant_id, previous_plan_slug, moved_to_plan_slug) as (
  values
    -- ('00000000-0000-0000-0000-000000000000'::uuid, 'hospital_starter', 'synapse_os_basic_annual'),
    (null::uuid, null::text, null::text)
)
update public.tenant_subscriptions ts
set
  plan_id = previous.id,
  updated_at = now()
from revert r
join public.subscription_plans previous on previous.slug = r.previous_plan_slug
join public.subscription_plans moved on moved.slug = r.moved_to_plan_slug
where r.tenant_id is not null
  and ts.tenant_id = r.tenant_id
  and ts.plan_id = moved.id
returning
  ts.tenant_id,
  previous.slug as restored_plan,
  ts.status;
