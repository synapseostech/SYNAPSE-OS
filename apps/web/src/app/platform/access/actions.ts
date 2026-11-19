"use server";

import { isAccountSuspensionMarker } from "@synapse/auth/account-suspension";
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { hashPassword, revokeAllUserSessions, validatePasswordStrength } from "@synapse/auth";
import { supabaseAdmin } from "@synapse/db/admin";
import { logPlatformAccessEvent } from "@/lib/platform/access-audit";
import { requirePlatformAccess } from "@/lib/platform/auth";
import { stepUpResult } from "@/lib/platform/step-up";
import { sendUserPasswordReset } from "@/lib/auth/password-reset.server";
import {
  assertCanManageRole,
  generateInviteToken,
  getPlatformMember,
  hashInviteToken,
  listPlatformMembers,
  platformRoleRequiresMfa,
  validatePlatformRole,
} from "@/lib/platform/membership.server";
import { MFA_MANDATORY_ROLES, manageableRoles, type PlatformRole } from "@/lib/platform/rbac";
import { sendPlatformInviteEmail, sendPlatformRoleChangedEmail } from "@/lib/platform/access-email";

const INVITE_TTL_HOURS = 72;

function appBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://synapseos.tech").replace(/\/$/, "");
}

function adminInviteUrl(token: string) {
  const adminHost = process.env.NEXT_PUBLIC_ADMIN_URL ?? "https://admin.synapseos.tech";
  return `${adminHost.replace(/\/$/, "")}/platform/invite/${token}`;
}

export async function invitePlatformMember(formData: FormData) {
  const actor = await requirePlatformAccess("user.invite");
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const platformRole = validatePlatformRole(String(formData.get("platform_role") ?? ""));
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const expiresAtRaw = String(formData.get("expires_at") ?? "").trim();
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;

  if (!email || !fullName) {
    return { ok: false as const, error: "Email and full name are required." };
  }

  assertCanManageRole(actor.platformRole, platformRole);
  // Granting an admin-grade role is as sensitive as changing one.
  if (MFA_MANDATORY_ROLES.includes(platformRole)) {
    const stepUp = await stepUpResult(actor);
    if (stepUp) return stepUp;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  let userId: string;
  const { data: existingProfile } = await db
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  if (existingProfile?.id) {
    userId = existingProfile.id as string;
    const { data: existingMembership } = await db
      .from("platform_memberships")
      .select("id, status, metadata")
      .eq("user_id", userId)
      .in("status", ["INVITED", "ACTIVE", "SUSPENDED"])
      .maybeSingle();
    if (isAccountSuspensionMarker(existingMembership)) {
      return { ok: false as const, error: "This account is suspended. Reactivate it in Users before granting platform access." };
    }
    if (existingMembership) {
      return { ok: false as const, error: "This user already has platform access." };
    }
  } else {
    const nameParts = fullName.split(" ");
    const profileId = randomUUID();
    const { data: created, error: createErr } = await db
      .from("profiles")
      .insert({
        id: profileId,
        email,
        full_name: fullName,
        first_name: nameParts[0] ?? fullName,
        last_name: nameParts.slice(1).join(" ") || null,
        role: "platform_observer",
        verification_status: "verified",
      })
      .select("id")
      .single();
    if (createErr || !created?.id) {
      return { ok: false as const, error: createErr?.message ?? "Failed to create profile." };
    }
    userId = created.id as string;
  }

  const { data: membership, error: membershipErr } = await db
    .from("platform_memberships")
    .insert({
      user_id: userId,
      platform_role: platformRole,
      status: "INVITED",
      invited_by: actor.id,
      invited_at: new Date().toISOString(),
      expires_at: expiresAt,
      mfa_required: platformRoleRequiresMfa(platformRole),
      notes,
      metadata: { visibility: formData.getAll("visibility_scopes") },
    })
    .select("id")
    .single();

  if (membershipErr || !membership?.id) {
    return { ok: false as const, error: membershipErr?.message ?? "Failed to create membership." };
  }

  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const inviteExpires = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  const { error: inviteErr } = await db.from("platform_invitations").insert({
    email,
    full_name: fullName,
    platform_role: platformRole,
    token_hash: tokenHash,
    status: "PENDING",
    invited_by: actor.id,
    membership_id: membership.id,
    expires_at: inviteExpires,
    notes,
    visibility_scopes: formData.getAll("visibility_scopes"),
  });

  if (inviteErr) {
    return { ok: false as const, error: inviteErr.message };
  }

  try {
    await sendPlatformInviteEmail({
      email,
      name: fullName,
      role: platformRole,
      inviteUrl: adminInviteUrl(token),
    });
  } catch (error) {
    console.error("[platform/access] invite email failed", error);
    return { ok: false as const, error: "Invitation created but email failed to send." };
  }

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_INVITED",
    targetUserId: userId,
    resourceId: membership.id as string,
    after: { email, platform_role: platformRole },
  });

  revalidatePath("/platform/access");
  return { ok: true as const, email };
}

export async function resendPlatformInvitation(formData: FormData) {
  const actor = await requirePlatformAccess("user.invite");
  const invitationId = String(formData.get("invitation_id") ?? "").trim();
  if (!invitationId) return { ok: false as const, error: "Invitation id required." };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data: invitation } = await db
    .from("platform_invitations")
    .select("*")
    .eq("id", invitationId)
    .eq("status", "PENDING")
    .maybeSingle();

  if (!invitation) return { ok: false as const, error: "Pending invitation not found." };

  const platformRole = validatePlatformRole(invitation.platform_role as string);
  assertCanManageRole(actor.platformRole, platformRole);

  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const inviteExpires = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  await db
    .from("platform_invitations")
    .update({
      token_hash: tokenHash,
      expires_at: inviteExpires,
      sent_at: new Date().toISOString(),
      resent_count: (invitation.resent_count as number) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invitationId);

  await sendPlatformInviteEmail({
    email: invitation.email as string,
    name: invitation.full_name as string,
    role: platformRole,
    inviteUrl: adminInviteUrl(token),
  });

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_INVITATION_RESENT",
    resourceId: invitationId,
    after: { email: invitation.email },
  });

  revalidatePath("/platform/access");
  return { ok: true as const };
}

export async function revokePlatformInvitation(formData: FormData) {
  const actor = await requirePlatformAccess("user.invite");
  const invitationId = String(formData.get("invitation_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!invitationId || !reason) {
    return { ok: false as const, error: "Invitation id and reason are required." };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data: invitation } = await db
    .from("platform_invitations")
    .select("*")
    .eq("id", invitationId)
    .eq("status", "PENDING")
    .maybeSingle();

  if (!invitation) return { ok: false as const, error: "Pending invitation not found." };
  assertCanManageRole(actor.platformRole, validatePlatformRole(invitation.platform_role as string));

  const now = new Date().toISOString();
  await db
    .from("platform_invitations")
    .update({ status: "REVOKED", revoked_at: now, updated_at: now })
    .eq("id", invitationId);

  if (invitation.membership_id) {
    await db
      .from("platform_memberships")
      .update({ status: "REVOKED", updated_at: now })
      .eq("id", invitation.membership_id as string);
  }

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_INVITATION_REVOKED",
    resourceId: invitationId,
    reason,
  });

  revalidatePath("/platform/access");
  return { ok: true as const };
}

export async function suspendPlatformMember(formData: FormData) {
  const actor = await requirePlatformAccess("user.suspend");
  const userId = String(formData.get("user_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };
  if (userId === actor.id) return { ok: false as const, error: "Cannot suspend your own account." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const now = new Date().toISOString();
  await db
    .from("platform_memberships")
    .update({ status: "SUSPENDED", updated_at: now })
    .eq("id", member.id);

  await revokeAllUserSessions(userId);

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_SUSPENDED",
    targetUserId: userId,
    resourceId: member.id,
    reason,
  });

  revalidatePath("/platform/access");
  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const };
}

export async function reactivatePlatformMember(formData: FormData) {
  const actor = await requirePlatformAccess("user.reactivate");
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return { ok: false as const, error: "User id required." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  await db
    .from("platform_memberships")
    .update({ status: "ACTIVE", updated_at: new Date().toISOString() })
    .eq("id", member.id);

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_REACTIVATED",
    targetUserId: userId,
    resourceId: member.id,
  });

  revalidatePath("/platform/access");
  return { ok: true as const };
}

export async function changePlatformMemberRole(formData: FormData) {
  const actor = await requirePlatformAccess("user.role.manage");
  const stepUp = await stepUpResult(actor);
  if (stepUp) return stepUp;
  const userId = String(formData.get("user_id") ?? "").trim();
  const newRole = validatePlatformRole(String(formData.get("platform_role") ?? ""));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };
  if (userId === actor.id && newRole === "SUPER_ADMIN" && actor.platformRole !== "SUPER_ADMIN") {
    return { ok: false as const, error: "Cannot elevate your own role." };
  }

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);
  assertCanManageRole(actor.platformRole, newRole);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  await db
    .from("platform_memberships")
    .update({
      platform_role: newRole,
      mfa_required: platformRoleRequiresMfa(newRole, member.mfaRequired),
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);

  await sendPlatformRoleChangedEmail({
    email: member.profile.email,
    name: member.profile.fullName ?? member.profile.email,
    role: newRole,
  }).catch(() => {});

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_ROLE_CHANGED",
    targetUserId: userId,
    resourceId: member.id,
    reason,
    before: { platform_role: member.platformRole },
    after: { platform_role: newRole },
  });

  revalidatePath("/platform/access");
  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const };
}

export async function resetPlatformMemberPassword(formData: FormData) {
  const actor = await requirePlatformAccess("user.password_reset");
  const userId = String(formData.get("user_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const revokeSessions = formData.get("revoke_sessions") === "true";
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);

  const result = await sendUserPasswordReset({
    userId,
    email: member.profile.email,
    name: member.profile.fullName ?? member.profile.email,
    appUrl: appBaseUrl(),
    activateIfPending: true,
  });

  if (!result.ok) return { ok: false as const, error: result.error };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  await db
    .from("platform_memberships")
    .update({ password_change_required: true, updated_at: new Date().toISOString() })
    .eq("id", member.id);

  if (revokeSessions) {
    await revokeAllUserSessions(userId);
  }

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_PASSWORD_RESET_REQUESTED",
    targetUserId: userId,
    resourceId: member.id,
    reason,
    after: { revoke_sessions: revokeSessions },
  });

  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const, email: result.email };
}

export async function issuePlatformTemporaryPassword(formData: FormData) {
  const actor = await requirePlatformAccess("user.password_reset");
  const userId = String(formData.get("user_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);

  const tempPassword = crypto.randomUUID().replace(/-/g, "").slice(0, 16) + "Aa1!";
  const strength = validatePasswordStrength(tempPassword);
  if (!strength.valid) {
    return { ok: false as const, error: "Failed to generate compliant temporary password." };
  }

  const passwordHash = await hashPassword(tempPassword);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  await db
    .from("profiles")
    .update({
      password_hash: passwordHash,
      must_change_password: true,
      email_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  await db
    .from("platform_memberships")
    .update({ password_change_required: true, updated_at: new Date().toISOString() })
    .eq("id", member.id);

  await revokeAllUserSessions(userId);

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_TEMP_PASSWORD_ISSUED",
    targetUserId: userId,
    resourceId: member.id,
    reason,
  });

  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const, temporaryPassword: tempPassword };
}

export async function revokePlatformMemberSessions(formData: FormData) {
  const actor = await requirePlatformAccess("user.session.revoke");
  const userId = String(formData.get("user_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };

  if (userId !== actor.id) {
    assertCanManageRole(actor.platformRole, member.platformRole);
  }

  await revokeAllUserSessions(userId);

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_SESSION_REVOKED",
    targetUserId: userId,
    resourceId: member.id,
    reason,
  });

  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const };
}

export async function resetPlatformMemberMfa(formData: FormData) {
  const actor = await requirePlatformAccess("user.mfa.manage");
  const stepUp = await stepUpResult(actor);
  if (stepUp) return stepUp;
  const userId = String(formData.get("user_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };
  if (userId === actor.id) return { ok: false as const, error: "Cannot reset your own MFA from this panel." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  await db.from("mfa_enrollments").delete().eq("user_id", userId);
  await revokeAllUserSessions(userId);

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_MFA_RESET",
    targetUserId: userId,
    resourceId: member.id,
    reason,
  });

  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const };
}

export async function revokePlatformMembership(formData: FormData) {
  const actor = await requirePlatformAccess("user.suspend");
  const stepUp = await stepUpResult(actor);
  if (stepUp) return stepUp;
  const userId = String(formData.get("user_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { ok: false as const, error: "User id and reason required." };
  if (userId === actor.id) return { ok: false as const, error: "Cannot revoke your own membership." };

  const member = await getPlatformMember(userId);
  if (!member) return { ok: false as const, error: "Member not found." };
  assertCanManageRole(actor.platformRole, member.platformRole);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  await db
    .from("platform_memberships")
    .update({ status: "REVOKED", updated_at: new Date().toISOString() })
    .eq("id", member.id);
  await revokeAllUserSessions(userId);

  await logPlatformAccessEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: "PLATFORM_MEMBER_REVOKED",
    targetUserId: userId,
    resourceId: member.id,
    reason,
  });

  revalidatePath("/platform/access");
  revalidatePath(`/platform/access/${userId}`);
  return { ok: true as const };
}

export async function getManageableRolesForActor(): Promise<PlatformRole[]> {
  const actor = await requirePlatformAccess("user.read");
  return manageableRoles(actor.platformRole);
}

export async function fetchPlatformMembersAction() {
  await requirePlatformAccess("user.read");
  return listPlatformMembers();
}
