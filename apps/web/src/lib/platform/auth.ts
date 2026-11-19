import { NextResponse } from "next/server";
import { getContext, getContextSafe, type SynapseContext } from "@synapse/auth/context";
import {
  ensureLegacyMembershipBootstrap,
  hasPlatformCapability,
  resolvePlatformAccess,
  touchPlatformAccess,
  type PlatformMembership,
} from "./membership.server";
import { navRequiresCapability, type PlatformCapability, type PlatformRole } from "./rbac";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export type PlatformAdminProfile = {
  id: string;
  sessionId: string;
  role: string;
  fullName: string | null;
  avatarUrl: string | null;
  email: string;
  platformRole: PlatformRole;
  membership: PlatformMembership | null;
  legacyAccess: boolean;
};

/** @deprecated Use resolvePlatformAccess — kept for transitional compatibility. */
export function hasPlatformAdminAccess(
  role: string | null | undefined,
  email: string | null | undefined
): boolean {
  if (role === "platform_admin") return true;
  if (email && ADMIN_EMAILS.length > 0 && ADMIN_EMAILS.includes(email.toLowerCase())) return true;
  return false;
}

async function loadPlatformProfile(ctx: SynapseContext): Promise<PlatformAdminProfile | null> {
  await ensureLegacyMembershipBootstrap(ctx.user.id, ctx.user.role, ctx.user.email);
  const access = await resolvePlatformAccess(ctx.user.id, ctx.user.role, ctx.user.email);
  if (!access) return null;

  if (access.membership) {
    await touchPlatformAccess(ctx.user.id);
  }

  return {
    id: ctx.user.id,
    sessionId: ctx.sessionId,
    role: ctx.user.role,
    fullName: ctx.user.fullName,
    avatarUrl: ctx.user.avatarUrl,
    email: ctx.user.email,
    platformRole: access.role,
    membership: access.membership,
    legacyAccess: access.legacy,
  };
}

function toPlatformAdminProfile(ctx: SynapseContext, platform: PlatformAdminProfile): PlatformAdminProfile {
  return {
    id: ctx.user.id,
    sessionId: ctx.sessionId,
    role: ctx.user.role,
    fullName: ctx.user.fullName,
    avatarUrl: ctx.user.avatarUrl,
    email: ctx.user.email,
    platformRole: platform.platformRole,
    membership: platform.membership,
    legacyAccess: platform.legacyAccess,
  };
}

/** Require any active platform control-plane membership (or legacy bootstrap access). */
export async function requirePlatformAccess(
  capability?: PlatformCapability
): Promise<PlatformAdminProfile> {
  const ctx: SynapseContext = await getContext("web", "/platform/login");
  const platform = await loadPlatformProfile(ctx);

  if (!platform) {
    const { redirect } = await import("next/navigation");
    redirect("/platform/login?error=unauthorized");
    throw new Error("unauthorized");
  }

  if (capability && !hasPlatformCapability(platform.platformRole, capability)) {
    const { redirect } = await import("next/navigation");
    redirect("/platform?error=forbidden");
    throw new Error("forbidden");
  }

  return toPlatformAdminProfile(ctx, platform);
}

/**
 * Gate a console page by its own path: the capability comes from
 * NAV_CAPABILITY_MAP, so the page, the sidebar and the route tests all agree.
 * Every page under app/platform calls this (see page-gates.test.ts).
 */
export async function requirePlatformPage(path: string): Promise<PlatformAdminProfile> {
  return requirePlatformAccess(navRequiresCapability(path));
}

/** Backward-compatible alias — equivalent to requirePlatformAccess(). */
export async function requirePlatformAdmin(): Promise<PlatformAdminProfile> {
  return requirePlatformAccess();
}

export async function requirePlatformAdminApi(
  capability?: PlatformCapability
): Promise<
  { ok: true; profile: PlatformAdminProfile } | { ok: false; response: NextResponse }
> {
  const ctx = await getContextSafe("web");
  if (!ctx) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "PLATFORM_FORBIDDEN",
          message: "Authentication required",
          request_id: crypto.randomUUID(),
        },
        { status: 401 }
      ),
    };
  }

  const platform = await loadPlatformProfile(ctx);
  if (!platform) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "PLATFORM_FORBIDDEN",
          message: "Platform access required",
          request_id: crypto.randomUUID(),
        },
        { status: 403 }
      ),
    };
  }

  if (capability && !hasPlatformCapability(platform.platformRole, capability)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "PLATFORM_FORBIDDEN",
          message: "Insufficient platform permissions",
          request_id: crypto.randomUUID(),
        },
        { status: 403 }
      ),
    };
  }

  return { ok: true, profile: toPlatformAdminProfile(ctx, platform) };
}

export function profileCanMutate(profile: PlatformAdminProfile): boolean {
  return hasPlatformCapability(profile.platformRole, "tenant.manage");
}
