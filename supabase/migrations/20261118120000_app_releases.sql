-- 20261118120000_app_releases
--
-- Every new Synapse APK announces itself.
--
-- The APK is installed outside any store, so until now a release reached
-- devices only when someone edited SYNAPSE_APP_* variables on the web
-- deployment and redeployed. This records each finished EAS Android build
-- instead, and GET /api/mobile/app-version answers from it (the variables stay
-- as a fallback while the table is empty).
--
--   app_releases                    one row per APK, keyed by versionCode
--   app_release_email_deliveries    one row per (release, address): the claim
--                                   that makes each announcement email go out
--                                   at most once, even when the webhook is
--                                   delivered twice or two senders race
--   app_release_email_preferences   who asked for release emails, and who
--                                   asked to stop (honoured for admins too)
--
-- All three are written and read only by the web server's service role. RLS
-- is on with no policies, and anon/authenticated hold no privileges, so
-- nothing here is reachable from a browser or the app's user session.
--
-- PREPARED ONLY: written for review. It has not been applied to any database
-- by this change; the owner applies it.

begin;

create table if not exists public.app_releases (
  id               uuid primary key default gen_random_uuid(),
  platform         text not null default 'android' check (platform in ('android')),
  version          text not null check (version ~ '^\d+\.\d+\.\d+$'),
  version_code     integer not null check (version_code > 0),
  -- The direct artifact: an https link whose path ends in .apk, so tapping it
  -- downloads the installer rather than opening a page.
  apk_url          text not null check (apk_url ~ '^https://[^\s]+\.apk$'),
  notes            text check (notes is null or char_length(notes) <= 280),
  -- Installs older than this must update before they continue. Null leaves
  -- the decision to SYNAPSE_APP_MIN_VERSION.
  minimum_version  text check (minimum_version is null or minimum_version ~ '^\d+\.\d+\.\d+$'),
  eas_build_id     text not null,
  build_profile    text,
  git_commit       text,
  source           text not null check (source in ('eas_webhook', 'workflow')),
  published_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (platform, version_code)
);

create index if not exists app_releases_latest_idx
  on public.app_releases (platform, version_code desc);

create table if not exists public.app_release_email_deliveries (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.app_releases(id) on delete cascade,
  email        text not null check (email = lower(email) and position('@' in email) > 1),
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider_id  text,
  error        text,
  claimed_at   timestamptz not null default now(),
  sent_at      timestamptz,
  unique (release_id, email)
);

create table if not exists public.app_release_email_preferences (
  email          text primary key check (email = lower(email) and position('@' in email) > 1),
  opted_in       boolean not null default false,
  opted_out_at   timestamptz,
  updated_at     timestamptz not null default now()
);

alter table public.app_releases enable row level security;
alter table public.app_release_email_deliveries enable row level security;
alter table public.app_release_email_preferences enable row level security;

revoke all on table public.app_releases from public, anon, authenticated;
revoke all on table public.app_release_email_deliveries from public, anon, authenticated;
revoke all on table public.app_release_email_preferences from public, anon, authenticated;

grant select, insert, update on table public.app_releases to service_role;
grant select, insert, update on table public.app_release_email_deliveries to service_role;
grant select, insert, update on table public.app_release_email_preferences to service_role;

commit;
