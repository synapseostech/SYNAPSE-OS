-- pharmacy_settings.tax_rate — widen the column and pin the unit.
--
-- The column shipped as numeric(5,4): five digits, four after the point, so the
-- largest value it can hold is 9.9999. The market it was built for charges a
-- rate in double figures, so as shipped the legacy tax field could not express
-- the only rate an operator would actually type.
--
-- The unit is a PERCENTAGE, not a fraction. That is what every consumer already
-- assumes, so widening the column changes no stored meaning:
--
--   apps/pharmacy/app/portal/pos/page.tsx      taxAmount = total * (taxRate / 100)
--   packages/db/src/pos-tax.ts                 taxAmount = base * rate / 100
--   apps/pharmacy/app/api/admin/settings       taxRate <-> tax_rate, unchanged
--   apps/web/.../mobile/pharmacy/settings      taxRate <-> tax_rate, unchanged
--
-- numeric(5,4) simply cannot hold "18". The settings API now refuses an
-- out-of-range rate with 422 instead of letting the upsert fail as a 500, and
-- this migration removes the ceiling that made the refusal necessary.
--
-- Existing values are preserved exactly: every value the old type could hold
-- (0 to 9.9999, scale 4) is representable in numeric(8,4) with no rounding and
-- no change of meaning. A tenant that has not configured tax keeps 0, and the
-- VAT path is untouched.
--
-- Forward-safe: widening only. No row is deleted, no other column changes, and
-- re-running is a no-op. There is no data rollback to write — narrowing back to
-- numeric(5,4) would destroy any rate of 10% or more, so it is deliberately not
-- provided. Rollback is "restore the column comment", which carries no data.
--
-- Applying this to a live database is an operator action and was NOT performed
-- by the change that added this file.

comment on column public.pharmacy_settings.tax_rate is
  'Legacy flat tax rate as a PERCENTAGE: 18 means 18%. Read as base * rate / 100. 0 disables tax; VAT settings take priority when vat_enabled is true.';

do $$
declare
  v_typmod integer;
  v_precision integer;
  v_scale integer;
begin
  select a.atttypmod into v_typmod
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'pharmacy_settings'
    and a.attname = 'tax_rate'
    and a.attnum > 0
    and not a.attisdropped;

  if not found then
    raise exception 'TAX_RATE_MISSING: public.pharmacy_settings.tax_rate does not exist';
  end if;

  -- Unbounded numeric needs nothing.
  if v_typmod = -1 then
    return;
  end if;

  v_precision := ((v_typmod - 4) >> 16) & 65535;
  v_scale := (v_typmod - 4) & 65535;

  -- Already at least as wide as the target: leave it alone rather than
  -- narrowing someone else's deliberate widening.
  if v_precision >= 8 and v_scale >= 4 then
    return;
  end if;

  execute 'alter table public.pharmacy_settings alter column tax_rate type numeric(8,4)';
end $$;
