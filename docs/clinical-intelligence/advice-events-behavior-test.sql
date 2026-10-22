-- Disposable-Postgres behaviour test for 20261007120000_clinical_intelligence_advice_events.sql
-- Run ONLY against a throwaway database: psql -f stub (below) -> migration -> this file.
-- Stub schema used (minimal stand-ins for Supabase roles and referenced tables):
-- create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
-- create table public.tenants (id uuid primary key default gen_random_uuid(), name text);
-- create table public.profiles (id uuid primary key default gen_random_uuid(), tenant_id uuid references public.tenants(id));
-- create table public.patients (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id));
-- create table public.encounters (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id), patient_id uuid references public.patients(id));
-- grant all on all tables in schema public to service_role;
-- alter default privileges in schema public grant all on tables to service_role, anon, authenticated;

\set ON_ERROR_STOP 0
insert into tenants(id,name) values ('aaaaaaaa-0000-4000-8000-000000000001','A'),('bbbbbbbb-0000-4000-8000-000000000002','B');
insert into profiles(id,tenant_id) values ('aaaaaaaa-1111-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001'),('bbbbbbbb-1111-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000002');
insert into patients(id,tenant_id) values ('aaaaaaaa-2222-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001'),('bbbbbbbb-2222-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000002');
insert into encounters(id,tenant_id,patient_id) values ('aaaaaaaa-3333-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-2222-4000-8000-000000000001'),('bbbbbbbb-3333-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000002','bbbbbbbb-2222-4000-8000-000000000002');
set role service_role;
\echo T1 valid advice (expect INSERT 0 1)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,patient_id,encounter_id,recommendation_id) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','advice','aaaaaaaa-2222-4000-8000-000000000001','aaaaaaaa-3333-4000-8000-000000000001','r1');
\echo T2 valid override (expect INSERT 0 1)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,encounter_id,recommendation_id,decision) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','override','aaaaaaaa-3333-4000-8000-000000000001','r1','REJECT');
\echo T3 cross-tenant encounter (expect ERROR encounter)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,encounter_id) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','advice','bbbbbbbb-3333-4000-8000-000000000002');
\echo T4 cross-tenant patient (expect ERROR patient)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,patient_id) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','advice','bbbbbbbb-2222-4000-8000-000000000002');
\echo T5 clinician from other tenant (expect ERROR clinician)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type) values ('aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-1111-4000-8000-000000000002','advice');
\echo T6 encounter/patient mismatch within tenant (expect ERROR encounter)
insert into patients(id,tenant_id) values ('aaaaaaaa-2222-4000-8000-0000000000ff','aaaaaaaa-0000-4000-8000-000000000001');
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,patient_id,encounter_id) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','advice','aaaaaaaa-2222-4000-8000-0000000000ff','aaaaaaaa-3333-4000-8000-000000000001');
\echo T7 override without decision (expect ERROR check)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','override');
\echo T8 invalid decision (expect ERROR check)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,decision) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','override','SIGN');
\echo T9 update as service_role (expect ERROR permission)
update clinical_ai_advice_events set decision='ACCEPT' where decision='REJECT';
\echo T10 delete as service_role (expect ERROR permission)
delete from clinical_ai_advice_events;
reset role;
\echo T11 update as owner (expect ERROR append-only via trigger)
update clinical_ai_advice_events set model='x';
\echo T12 delete as owner (expect ERROR append-only)
delete from clinical_ai_advice_events;
\echo T13 truncate as owner (expect ERROR append-only)
truncate clinical_ai_advice_events;
set role authenticated;
\echo T14 authenticated select (expect ERROR permission)
select count(*) from clinical_ai_advice_events;
reset role;
set role anon;
\echo T15 anon insert (expect ERROR permission)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','advice');
reset role;
\echo T16 rows retained (expect 2)
select count(*) from clinical_ai_advice_events;
\echo T17 rls enabled + no policies
select relrowsecurity, (select count(*) from pg_policies where tablename='clinical_ai_advice_events') policies from pg_class where relname='clinical_ai_advice_events';
\echo T18 payload not object (expect ERROR check)
insert into clinical_ai_advice_events(tenant_id,clinician_id,event_type,payload) values ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-1111-4000-8000-000000000001','advice','[1]');
\echo T19 rollback statements apply cleanly in a txn
begin; drop table if exists public.clinical_ai_advice_events; drop function if exists public.clinical_ai_advice_events_guard(); select to_regclass('public.clinical_ai_advice_events') as after_drop; rollback;
