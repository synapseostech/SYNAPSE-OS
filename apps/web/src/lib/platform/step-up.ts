import { NextResponse } from "next/server";
import { hasRecentVerifiedMfa } from "@synapse/auth";
import type { PlatformAdminProfile } from "./auth";

export const STEP_UP_REQUIRED_CODE = "MFA_STEP_UP_REQUIRED" as const;
export const STEP_UP_MESSAGE =
  "Enter a fresh code from your authenticator to confirm this action.";

/**
 * Sensitive console actions (purging a tenant, impersonating a user, changing a
 * staff role, resetting someone's MFA) need proof of the caller's authenticator
 * from the last 5 minutes, on top of the capability. The client gets that proof
 * by POSTing a code to /api/platform/mfa/step-up and then retries the action.
 */
export async function hasRecentStepUp(profile: Pick<PlatformAdminProfile, "id" | "sessionId">): Promise<boolean> {
  return hasRecentVerifiedMfa(profile.id, profile.sessionId);
}

/** Server-action form: returns an error result the client recognises. */
export async function stepUpResult(
  profile: Pick<PlatformAdminProfile, "id" | "sessionId">,
): Promise<null | { ok: false; code: typeof STEP_UP_REQUIRED_CODE; error: string }> {
  if (await hasRecentStepUp(profile)) return null;
  return { ok: false, code: STEP_UP_REQUIRED_CODE, error: STEP_UP_MESSAGE };
}

/** Route-handler form: a 403 the client recognises, or null to continue. */
export async function stepUpResponse(
  profile: Pick<PlatformAdminProfile, "id" | "sessionId">,
): Promise<NextResponse | null> {
  if (await hasRecentStepUp(profile)) return null;
  return NextResponse.json(
    { code: STEP_UP_REQUIRED_CODE, error: STEP_UP_MESSAGE },
    { status: 403 },
  );
}
