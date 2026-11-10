begin;

-- The first claim for a pharmacy inserted its own lease token as part of
-- reserving the row, then read that row back and saw a live lease — its own —
-- so every first apply was refused as "busy" for fifteen minutes.
--
-- The row now reserves the session only; the lease is granted afterwards. A
-- live lease names an owner: a duplicate request from that session waits, and
-- another session waits unless it declares itself the continuation of the
-- session holding the lease. A row with no live lease is stale and free to
-- take, whichever session last wrote it, so an abandoned attempt cannot lock a
-- pharmacy out of its own cut-over.
create or replace function public.claim_pharmacy_tally_cutover_apply(
  p_tenant_id uuid,
  p_session_id uuid,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_session_id uuid;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
begin
  if p_lease_token is null then
    raise exception 'Tally apply lease token is required';
  end if;

  if not exists (
    select 1
    from public.pharmacy_import_sessions
    where id = p_session_id
      and tenant_id = p_tenant_id
      and source_system = 'Tally'
  ) then
    return 'invalid_session';
  end if;

  insert into public.pharmacy_tally_cutover_locks (
    tenant_id,
    session_id,
    lease_token,
    lease_expires_at
  )
  values (
    p_tenant_id,
    p_session_id,
    null,
    null
  )
  on conflict (tenant_id) do nothing;

  select session_id, lease_token, lease_expires_at
  into v_session_id, v_lease_token, v_lease_expires_at
  from public.pharmacy_tally_cutover_locks
  where tenant_id = p_tenant_id
  for update;

  if v_lease_token is not null and v_lease_expires_at > clock_timestamp() then
    if v_session_id = p_session_id then
      return 'busy';
    end if;

    if not exists (
      select 1
      from public.pharmacy_import_sessions s
      where s.id = p_session_id
        and s.tenant_id = p_tenant_id
        and s.ai_mapping ->> 'continuationOf' = v_session_id::text
    ) then
      return 'owned_by_another_session';
    end if;
  end if;

  update public.pharmacy_tally_cutover_locks
  set session_id = p_session_id,
      lease_token = p_lease_token,
      lease_expires_at = clock_timestamp() + interval '15 minutes'
  where tenant_id = p_tenant_id;

  return 'acquired';
end;
$function$;

revoke all on function public.claim_pharmacy_tally_cutover_apply(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_pharmacy_tally_cutover_apply(uuid, uuid, uuid)
  to service_role;

commit;
