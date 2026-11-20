import type { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { validateSession, verifyToken } from "@synapse/auth"
import { SESSION_COOKIE } from "@synapse/config/constants"
import { checkRateLimit, rateLimiters } from "../rate-limit"
import { resolveCompanionProvider } from "./provider"
import type { CompanionDeps } from "./service"
import { createSupabaseCompanionStore } from "./supabase-store"

/**
 * The companion's only notion of "who": the verified session subject, from the
 * APK's Bearer token or the web session cookie. Any user id in the request body
 * or query is ignored.
 */
export async function resolveCompanionUser(req: NextRequest): Promise<string | null> {
  const header = req.headers.get("authorization") ?? ""
  let token = header.startsWith("Bearer ") ? header.slice(7).trim() : null
  if (!token) {
    const store = await cookies()
    token = store.get(SESSION_COOKIE)?.value ?? null
  }
  if (!token) return null
  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return null
  const { valid } = await validateSession(token)
  return valid ? String(payload.sub) : null
}

export function defaultCompanionDeps(): CompanionDeps {
  return {
    store: createSupabaseCompanionStore(),
    provider: resolveCompanionProvider(process.env),
    burstCheck: async (userId) => (await checkRateLimit(rateLimiters.ai, `companion:${userId}`)).success,
  }
}
