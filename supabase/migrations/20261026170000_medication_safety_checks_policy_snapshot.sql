-- 20261026170000_medication_safety_checks_policy_snapshot
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- Adds the one column `medication_safety_checks` needs to answer the question a
-- reviewer will actually ask of it: under which enforcement policy did this
-- check block, warn or allow?
--
-- The table already records what was found (`alerts_raised`), how many were
-- clinically actionable (`alert_count`), and whether a human overrode the block
-- (`was_overridden`, `override_by`, `override_reason`). It records nothing about
-- the rule that turned findings into a decision. That rule is configurable per
-- deployment (see `app-env` / `CLINICAL_SAFETY_*`), so a row without it cannot
-- be interpreted once the environment changes — which is exactly when someone
-- reads the audit trail.
--
-- Defaulting to `{}` rather than NULL keeps the column non-null for the existing
-- backfill and makes "no policy recorded" an explicitly empty object rather than
-- an ambiguous absence. On PostgreSQL 11 and later this is a catalogue-only
-- change: no table rewrite, no long lock.
--
-- Safe to re-run. Nothing reads this column yet, so applying it before the
-- application code that writes it is order-independent.

alter table if exists public.medication_safety_checks
  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb;

comment on column public.medication_safety_checks.policy_snapshot is
  'The enforcement policy and coverage states in force when this check ran: decision, blocking reasons, per-domain coverage, and any policy-configuration warnings. Written by apps/web/src/lib/clinical-safety/record.ts.';
