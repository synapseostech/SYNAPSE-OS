# PROPOSED: legacy hospital plan reassignment (prepared, not applied)

Status: **prepared, not executed**. Lives under `supabase/proposed/` so the
migration runner never reads it. A human runs these statements against
production, per tenant.

## Why this exists

`20261029090000_plan_feature_entitlements.sql` seeded the three commercial
plans, so every tenant on `synapse_os_basic_annual`,
`synapse_os_lab_addon_annual` or `synapse_lab_annual` is now entitled. It
deliberately did not touch the legacy `hospital_*` shells, which have zero
`plan_features` **by design** — `20260716104338_hospital_module_registry_seed.sql`
line 7 states `FLAG-OFF: no hospital_modules tenant rows, no plan_features for
hospital plans`.

Production inventory on 2026-09-28 held ten tenants on `hospital_starter`, all
`trialing`. They stay locked out until their `tenant_subscriptions.plan_id`
points at a commercial plan. That is a tenant-data change, so it is not a
migration and it is not in the seed.

## Order of operations

1. **`inspect.sql`** — read-only. Keep the output; it is the only record of the
   previous `plan_id` (the SQL path writes no audit row, unlike the platform
   suspend/reactivate actions, which append to `audit_log` and
   `subscription_events`).
2. Decide the target per tenant:
   - `hospital_starter` → `synapse_os_basic_annual`
   - `hospital_professional` → `synapse_os_basic_annual`, or
     `synapse_os_lab_addon_annual` if that tenant contracted the lab module
   - `hospital_enterprise` → `synapse_enterprise` grants nothing (empty until a
     custom quote). Leave it alone or use `tenant_feature_overrides`.
3. Reassign. Either:
   - **platform UI (preferred)** — `/platform/hospitals`, pick the plan in the
     row's selector and press **Set plan**. The action requires
     `platform.subscription.manage` and writes `subscription.plan_changed` to
     `audit_log` and `subscription_events`, which the SQL path below does not.
   - **`reassign.sql`** — fill the `decisions` list with `tenant_id` values from
     step 1, then run once. The `RETURNING` block lists exactly what moved; if a
     tenant is missing from it, the target slug did not match a plan row.
4. Status is untouched. A `past_due` or `suspended` row still needs
   reactivation from `/platform/billing` (`subscription.reactivated`), or a
   trial extension via `extend_trial_days` in step 3 plus reactivation.
5. **`verify.sql`** — read-only. Prints a per-tenant `verdict` from
   `has_feature()`, the same gate the portal and the mobile API call. Every
   row should read `ENTITLED`; a row reading `PLAN OK — REACTIVATE` means the
   plan moved and the status did not, so step 4 is still outstanding.
6. **`rollback.sql`** — fill from the step 1 output and run only if needed.

## Caveats

- `tenant_feature_overrides` win over the plan. `inspect.sql` counts enabled
  overrides; a tenant with overrides was already partly entitled and will keep
  those keys regardless of the plan.
- `tenant_subscriptions` is unique per tenant, so an OS + Lab facility is one
  row pointing at the add-on plan, not two subscriptions. `synapse_os_lab_addon_annual.price_ugx`
  is the add-on delta (500 000); invoicing must charge OS Basic plus add-on.
- Do not bulk-run this. One decision per tenant, reviewed against its contract.
- These files are not migrations. Do not move them into `supabase/migrations/`.

## Platform action

`reassignSubscriptionPlan` in `apps/web/src/app/platform/_lib/subscription-actions.ts`
now performs this through the UI, with the same capability gate and the same
audit writes as suspend / reactivate / extend. It changes `plan_id` only:
status and the `agreed_price_ugx` snapshot are left untouched, and
`apps/web/src/app/platform/hospitals/page.tsx` labels legacy plans `(legacy)`
in the selector. Covered by `subscription-actions.authz.test.ts`.
