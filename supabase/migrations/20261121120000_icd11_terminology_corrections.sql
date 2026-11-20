-- ICD-11 terminology corrections, checked against the WHO ICD-11 MMS 2026-01
-- Simple Tabulation (the same file packages/interop/src/terminology/icd11-mms-data.ts
-- is generated from).
--
-- 1. icd11_cache held four seed rows with made-up foundation URIs, and '5A21'
--    titled "Diabetic ketoacidosis". In ICD-11, 5A21 is "Hypoglycaemia in the
--    context of diabetes mellitus"; DKA is 5A22.0 (without coma) / 5A22.3
--    (with coma). Rows are replaced with WHO's own titles and foundation URIs.
-- 2. The 'dka-emergency' pathway was keyed on 5A21 (hypoglycaemia), so it
--    would fire for the opposite emergency. It now keys on 5A22.0 and 5A22.3.
-- 3. The 'pph-protocol' pathway was keyed on 1E08, which is not an ICD-11 code,
--    so it could never fire. It now keys on JA43 (postpartum haemorrhage) and
--    its children JA43.0 / JA43.1.
-- 4. The global DHIS2 mapping sent 5A21 as DIABETES. Diabetes in HMIS means
--    type 1 / type 2 diabetes: 5A10 and 5A11.
--
-- Production had 0 encounter_diagnoses rows coded 5A21 when this was written.
-- Idempotent: every statement can run twice.

begin;

delete from public.icd11_cache
 where source = 'seed'
   and stem_code in ('1G40', '1F40', 'CA40', '5A21');

insert into public.icd11_cache (stem_code, title, foundation_uri, linearization_uri, classification, release, source)
values
  ('1G40',   'Sepsis without septic shock',          'http://id.who.int/icd/entity/622600769',  'https://id.who.int/icd/release/11/2026-01/mms/622600769',  'ICD-11 MMS', '2026-01', 'who-2026-01'),
  ('1F40',   'Malaria due to Plasmodium falciparum', 'http://id.who.int/icd/entity/579583286',  'https://id.who.int/icd/release/11/2026-01/mms/579583286',  'ICD-11 MMS', '2026-01', 'who-2026-01'),
  ('CA40',   'Pneumonia',                            'http://id.who.int/icd/entity/142052508',  'https://id.who.int/icd/release/11/2026-01/mms/142052508',  'ICD-11 MMS', '2026-01', 'who-2026-01'),
  ('5A22.0', 'Diabetic ketoacidosis without coma',   'http://id.who.int/icd/entity/540530695',  'https://id.who.int/icd/release/11/2026-01/mms/540530695',  'ICD-11 MMS', '2026-01', 'who-2026-01')
on conflict (stem_code) do update
  set title = excluded.title,
      foundation_uri = excluded.foundation_uri,
      linearization_uri = excluded.linearization_uri,
      source = excluded.source,
      updated_at = now();

update public.clinical_pathway_templates
   set icd11_codes = array['5A22.0', '5A22.3']
 where slug = 'dka-emergency'
   and icd11_codes = array['5A21'];

update public.clinical_pathway_templates
   set icd11_codes = array['JA43', 'JA43.0', 'JA43.1']
 where slug = 'pph-protocol'
   and icd11_codes = array['1E08'];

update public.dhis2_data_element_mappings
   set icd11_stem_code = '5A11',
       display_name = 'Type 2 diabetes mellitus'
 where tenant_id is null
   and icd11_stem_code = '5A21'
   and hmis_code = 'DIABETES'
   and not exists (
     select 1 from public.dhis2_data_element_mappings m
      where m.tenant_id is null and m.icd11_stem_code = '5A11'
   );

insert into public.dhis2_data_element_mappings (tenant_id, icd11_stem_code, dhis2_data_element_id, display_name, hmis_code)
select null, '5A10', d.dhis2_data_element_id, 'Type 1 diabetes mellitus', 'DIABETES'
  from public.dhis2_data_element_mappings d
 where d.tenant_id is null and d.icd11_stem_code = '5A11' and d.hmis_code = 'DIABETES'
   and not exists (
     select 1 from public.dhis2_data_element_mappings m
      where m.tenant_id is null and m.icd11_stem_code = '5A10'
   )
 limit 1;

commit;
