-- AI health companion for My Synapse Health account holders.
--
-- Accounts are owned by SYNAPSE custom auth, so user_id is the session subject
-- and deliberately carries no foreign key to auth.users (the older
-- ai_health_chats table does, which is why its writes fail for most accounts).
-- Every table is reached only through the server route with the service role;
-- RLS is on with no policies so anon/authenticated clients see nothing.

CREATE TABLE IF NOT EXISTS public.health_companion_consents (
  user_id      UUID PRIMARY KEY,
  medications  BOOLEAN NOT NULL DEFAULT false,
  appointments BOOLEAN NOT NULL DEFAULT false,
  readings     BOOLEAN NOT NULL DEFAULT false,
  labs         BOOLEAN NOT NULL DEFAULT false,
  wearables    BOOLEAN NOT NULL DEFAULT false,
  accepted_terms_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.health_companion_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  title       TEXT NOT NULL DEFAULT 'Conversation',
  language    TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'lg', 'sw')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_companion_conversations_user
  ON public.health_companion_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.health_companion_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.health_companion_conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- none | emergency | dose_refusal | output_blocked | provider_unavailable
  safety_kind     TEXT NOT NULL DEFAULT 'none',
  provider        TEXT,
  model           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_companion_messages_conversation
  ON public.health_companion_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_health_companion_messages_user
  ON public.health_companion_messages (user_id, created_at DESC);

-- Daily usage counters. They hold no message content and survive conversation
-- deletion, so deleting a chat cannot reset the free-tier quota.
CREATE TABLE IF NOT EXISTS public.health_companion_usage (
  user_id  UUID NOT NULL,
  used_on  DATE NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, used_on)
);

ALTER TABLE public.health_companion_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_companion_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_companion_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_companion_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.health_companion_consents FROM anon, authenticated;
REVOKE ALL ON public.health_companion_conversations FROM anon, authenticated;
REVOKE ALL ON public.health_companion_messages FROM anon, authenticated;
REVOKE ALL ON public.health_companion_usage FROM anon, authenticated;

-- Atomically take one unit of quota for (user, today UTC). Returns the new
-- count, or NULL when the limit is already reached. SECURITY INVOKER: only the
-- service role may call it.
CREATE OR REPLACE FUNCTION public.health_companion_take_quota(p_user_id UUID, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO public.health_companion_usage AS u (user_id, used_on, count)
  VALUES (p_user_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (user_id, used_on)
  DO UPDATE SET count = u.count + 1
  WHERE u.count < p_limit
  RETURNING count;
$$;

REVOKE ALL ON FUNCTION public.health_companion_take_quota(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_companion_take_quota(UUID, INTEGER) TO service_role;
