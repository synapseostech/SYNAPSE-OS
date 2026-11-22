-- Radiology workflow on the existing imaging_studies / radiology_reports tables.
--
-- Capabilities that existed: doctor@hospital radiology.order.create,
-- radiographer@hospital radiology.order.read + radiology.report.write,
-- radiologist@hospital radiology.report.verify. A radiologist could verify but
-- not see the worklist, and clinical officers (who order most imaging in
-- Ugandan health centres) could not request an exam. This adds:
--   radiologist      order.read, report.write (they also draft)
--   clinical_officer order.create
--   hospital_admin   order.read
-- plus indexes for the worklist and report lookups. No data changes;
-- production had 0 imaging studies and 0 radiology reports. Idempotent.

begin;

insert into public.capabilities (module, resource, action, description) values
  ('radiology', 'order', 'create', 'Request an imaging exam'),
  ('radiology', 'order', 'read', 'See the imaging worklist'),
  ('radiology', 'report', 'write', 'Write a radiology report draft'),
  ('radiology', 'report', 'verify', 'Verify (sign) a radiology report')
on conflict (module, resource, action) do nothing;

insert into public.role_capabilities (role, facility_type, capability_id)
select g.role, 'hospital', c.id
from (values
  ('radiologist', 'order', 'read'),
  ('radiologist', 'report', 'write'),
  ('clinical_officer', 'order', 'create'),
  ('hospital_admin', 'order', 'read')
) as g(role, resource, action)
join public.capabilities c on c.module = 'radiology' and c.resource = g.resource and c.action = g.action
on conflict (role, facility_type, capability_id) do nothing;

create index if not exists imaging_studies_worklist_idx
  on public.imaging_studies (tenant_id, hospital_id, worklist_status, created_at desc)
  where coalesce(is_deleted, false) = false;

create index if not exists imaging_studies_encounter_idx
  on public.imaging_studies (tenant_id, encounter_id)
  where encounter_id is not null;

create index if not exists radiology_reports_study_idx
  on public.radiology_reports (tenant_id, study_id)
  where study_id is not null;

commit;
