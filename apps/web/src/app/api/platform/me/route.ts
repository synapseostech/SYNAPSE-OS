import { NextResponse } from "next/server"
import { requirePlatformAdminApi } from "@/lib/platform/auth"
import { NAV_CAPABILITY_MAP, roleCapabilities, roleLabel } from "@/lib/platform/rbac"

export const dynamic = "force-dynamic"

/**
 * The caller's platform role and the console paths it may open, so the
 * sidebar can hide the rest. Hiding is a convenience only: every page and API
 * checks its own capability on the server.
 */
export async function GET() {
  const auth = await requirePlatformAdminApi()
  if (!auth.ok) return auth.response
  const role = auth.profile.platformRole
  const capabilities = roleCapabilities(role)
  const allowedPaths = Object.entries(NAV_CAPABILITY_MAP)
    .filter(([, cap]) => capabilities.includes(cap))
    .map(([path]) => path)
  return NextResponse.json(
    { role, roleLabel: roleLabel(role), capabilities, allowedPaths },
    { headers: { "Cache-Control": "private, no-store" } },
  )
}
