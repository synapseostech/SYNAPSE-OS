BEGIN;

CREATE TABLE IF NOT EXISTS public.pharmacy_tally_cutover_locks (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.pharmacy_import_sessions(id) ON DELETE RESTRICT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pharmacy_tally_cutover_lock_lease_pair
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

ALTER TABLE public.pharmacy_tally_cutover_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pharmacy_tally_cutover_locks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.pharmacy_tally_cutover_locks TO service_role;

CREATE OR REPLACE FUNCTION public.claim_pharmacy_tally_cutover_apply(
  p_tenant_id UUID,
  p_session_id UUID,
  p_lease_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id UUID;
  v_lease_token UUID;
  v_lease_expires_at TIMESTAMPTZ;
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'Tally apply lease token is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.pharmacy_import_sessions
    WHERE id = p_session_id
      AND tenant_id = p_tenant_id
      AND source_system = 'Tally'
  ) THEN
    RETURN 'invalid_session';
  END IF;

  INSERT INTO public.pharmacy_tally_cutover_locks (
    tenant_id,
    session_id,
    lease_token,
    lease_expires_at
  )
  VALUES (
    p_tenant_id,
    p_session_id,
    p_lease_token,
    clock_timestamp() + INTERVAL '15 minutes'
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT session_id, lease_token, lease_expires_at
  INTO v_session_id, v_lease_token, v_lease_expires_at
  FROM public.pharmacy_tally_cutover_locks
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF v_session_id IS DISTINCT FROM p_session_id THEN
    RETURN 'owned_by_another_session';
  END IF;

  IF v_lease_token IS NOT NULL AND v_lease_expires_at > clock_timestamp() THEN
    RETURN 'busy';
  END IF;

  UPDATE public.pharmacy_tally_cutover_locks
  SET lease_token = p_lease_token,
      lease_expires_at = clock_timestamp() + INTERVAL '15 minutes'
  WHERE tenant_id = p_tenant_id;

  RETURN 'acquired';
END;
$$;

CREATE OR REPLACE FUNCTION public.release_pharmacy_tally_cutover_apply(
  p_tenant_id UUID,
  p_session_id UUID,
  p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.pharmacy_tally_cutover_locks
  SET lease_token = NULL,
      lease_expires_at = NULL
  WHERE tenant_id = p_tenant_id
    AND session_id = p_session_id
    AND lease_token = p_lease_token;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pharmacy_tally_cutover_apply(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_pharmacy_tally_cutover_apply(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pharmacy_tally_cutover_apply(UUID, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_pharmacy_tally_cutover_apply(UUID, UUID, UUID)
  TO service_role;

COMMIT;
