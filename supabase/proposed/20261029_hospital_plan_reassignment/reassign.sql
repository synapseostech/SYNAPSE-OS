-- PREPARED — not executed. Run inspect.sql first and keep its output.
--
-- Points named tenants' single tenant_subscriptions row at a commercial plan.
-- It writes only tenant_subscriptions.plan_id / trial_ends / updated_at —
-- no tenant-owned table is touched, and no row leaves a legacy hospital_*
-- plan unless it is named below.
--
-- Fill `decisions`, then run this file once. Every decision needs the
-- tenant_id from inspect.sql (not the slug: slugs are not unique-constrained).
--
--   target_plan_slug   synapse_os_basic_annual        hospital / clinic
--                      synapse_os_lab_addon_annual    contracted lab module
--                      synapse_lab_annual             standalone laboratory
--                      synapse_enterprise             EMPTY by design — a
--                                                     reassignment to it
--                                                     grants nothing
--
--   extend_trial_days  NULL leaves trial_ends alone. A number moves the trial
--                      clock forward from now. It does NOT change status:
--                      a past_due or suspended row still needs reactivation
--                      from /platform/billing (subscription.reactivated).

with decisions(tenant_id, target_plan_slug, extend_trial_days) as (
  values
    -- ('00000000-0000-0000-0000-000000000000'::uuid, 'synapse_os_basic_annual', null::int),
    (null::uuid, null::text, null::int)
)
update public.tenant_subscriptions ts
set
  plan_id = target.id,
  trial_ends = case
    when d.extend_trial_days is null then ts.trial_ends
    else now() + make_interval(days => d.extend_trial_days)
  end,
  updated_at = now()
from decisions d
join public.subscription_plans target on target.slug = d.target_plan_slug
where d.tenant_id is not null
  and ts.tenant_id = d.tenant_id
  and ts.plan_id in (
    select id from public.subscription_plans where slug like 'hospital\_%'
  )
returning
  ts.tenant_id,
  target.slug   as new_plan,
  ts.status,
  ts.trial_ends;
