"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  ADMIN_ROLES,
  MFA_MANDATORY_ROLES,
  OBSERVER_ROLES,
  PLATFORM_ROLES,
  ROLE_DESCRIPTIONS,
  STEP_UP_CAPABILITIES,
  manageableRoles,
  roleCapabilities,
  roleLabel,
  statusLabel,
  type PlatformRole,
} from "@/lib/platform/rbac";
import type { PlatformMemberRow } from "@/lib/platform/membership.server";
import { useStepUp } from "../_components/step-up";
import {
  changePlatformMemberRole,
  invitePlatformMember,
  resendPlatformInvitation,
  revokePlatformInvitation,
  resetPlatformMemberPassword,
  issuePlatformTemporaryPassword,
  revokePlatformMemberSessions,
  resetPlatformMemberMfa,
  revokePlatformMembership,
  suspendPlatformMember,
  reactivatePlatformMember,
} from "./actions";

type InvitationRow = {
  id: string;
  email: string;
  full_name: string;
  platform_role: string;
  status: string;
  sent_at: string;
  expires_at: string;
  resent_count: number;
};

export function PlatformAccessClient({
  members,
  invitations,
  actorRole,
}: {
  members: PlatformMemberRow[];
  invitations: InvitationRow[];
  actorRole: PlatformRole;
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { withStepUp, dialog } = useStepUp();
  // The roles this actor may grant (the server re-checks with assertCanManageRole).
  const manageable = manageableRoles(actorRole);
  const [inviteRole, setInviteRole] = useState<PlatformRole | "">(manageable[0] ?? "");

  const active = members.filter((m) => m.status === "ACTIVE");
  const suspended = members.filter((m) => m.status === "SUSPENDED");
  const invited = members.filter((m) => m.status === "INVITED");
  const observers = members.filter((m) => OBSERVER_ROLES.includes(m.platformRole));
  const administrators = members.filter((m) => ADMIN_ROLES.includes(m.platformRole));

  function onInvite(formData: FormData) {
    startTransition(async () => {
      const result = await withStepUp(() => invitePlatformMember(formData));
      setMessage(result.ok ? `Invitation sent to ${result.email}` : result.error);
      if (result.ok) setShowInvite(false);
    });
  }

  return (
    <div className="space-y-6">
      {dialog}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Governance</p>
          <h1 className="mt-2 text-2xl font-bold">Platform staff</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Invite Synapse staff and observers and give each a role. Open a person to change their role, reset MFA,
            revoke sessions or remove access. Sensitive changes ask for your authenticator code.
          </p>
        </div>
        <button
          type="button"
          disabled={manageable.length === 0}
          title={manageable.length === 0 ? "Your role cannot invite platform staff" : undefined}
          onClick={() => setShowInvite(true)}
          className="rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A]"
        >
          Invite Member
        </button>
      </section>

      {message ? (
        <p className="rounded-lg border border-slate-700 bg-[#111117] px-4 py-3 text-sm text-slate-200">{message}</p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Active", active.length],
          ["Pending", invited.length + invitations.length],
          ["Observers", observers.length],
          ["Administrators", administrators.length],
          ["Suspended", suspended.length],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-[#F97316]">{Number(value)}</p>
          </article>
        ))}
      </section>

      {showInvite ? (
        <form action={onInvite} className="rounded-xl border border-slate-800 bg-[#111117] p-5 space-y-4">
          <h2 className="text-sm font-semibold">Invite Member</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-slate-400">Email</span>
              <input name="email" type="email" required className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-slate-400">Full name</span>
              <input name="full_name" required className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-slate-400">Platform role</span>
              <select
                name="platform_role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as PlatformRole)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2"
              >
                {manageable.map((role) => (
                  <option key={role} value={role}>{roleLabel(role)}</option>
                ))}
              </select>
              {inviteRole ? (
                <span className="mt-1 block text-xs text-slate-500">
                  {ROLE_DESCRIPTIONS[inviteRole]}
                  {MFA_MANDATORY_ROLES.includes(inviteRole) ? " Requires MFA; you will confirm with your authenticator." : ""}
                </span>
              ) : null}
            </label>
            <label className="block text-sm">
              <span className="text-slate-400">Access expiry (optional)</span>
              <input name="expires_at" type="date" className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-slate-400">Notes</span>
            <textarea name="notes" rows={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2" />
          </label>
          <div className="flex gap-2">
            <button disabled={pending} type="submit" className="rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A]">
              {pending ? "Sending…" : "Send Invitation"}
            </button>
            <button type="button" onClick={() => setShowInvite(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <MemberTable title="Active Members" rows={active} />
      <InvitationTable
        invitations={invitations}
        onResend={(id) =>
          startTransition(async () => {
            const fd = new FormData();
            fd.set("invitation_id", id);
            const result = await resendPlatformInvitation(fd);
            setMessage(result.ok ? "Invitation resent." : result.error);
          })
        }
        onRevoke={(id) => {
          const reason = window.prompt("Reason for revoking invitation:");
          if (!reason) return;
          startTransition(async () => {
            const fd = new FormData();
            fd.set("invitation_id", id);
            fd.set("reason", reason);
            const result = await revokePlatformInvitation(fd);
            setMessage(result.ok ? "Invitation revoked." : result.error);
          });
        }}
      />
      <MemberTable title="Suspended" rows={suspended} />
      <RoleMatrix />
    </div>
  );
}

const ROLE_SHORT: Record<PlatformRole, string> = {
  SUPER_ADMIN: "Super",
  PLATFORM_ADMIN: "Platform",
  OPERATIONS_ADMIN: "Ops",
  RELEASE_MANAGER: "Release",
  SECURITY_ADMIN: "Security",
  FINANCE_ADMIN: "Finance",
  SUPPORT_ADMIN: "Support",
  CLINICAL_GOVERNANCE: "Clinical",
  STAKEHOLDER: "Stake",
  BOARD_OBSERVER: "Board",
  INVESTOR_OBSERVER: "Investor",
  TECHNICAL_OBSERVER: "Tech",
  AUDITOR: "Auditor",
  READ_ONLY_OBSERVER: "Read-only",
};

/** Every role against every capability, read straight from rbac.ts. */
function RoleMatrix() {
  const caps = Array.from(new Set(PLATFORM_ROLES.flatMap((r) => roleCapabilities(r)))).sort();
  return (
    <details className="rounded-xl border border-slate-800 bg-[#111117]">
      <summary className="cursor-pointer p-4 text-sm font-semibold">What each role can do</summary>
      <div className="space-y-3 border-t border-slate-800 p-4">
        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {PLATFORM_ROLES.map((role) => (
            <li key={role}>
              <span className="font-medium text-slate-200">{roleLabel(role)}</span>
              {MFA_MANDATORY_ROLES.includes(role) ? <span className="ml-2 rounded bg-amber-500/10 px-1.5 text-[10px] text-amber-300">MFA</span> : null}
              <span className="block text-xs text-slate-500">{ROLE_DESCRIPTIONS[role]}</span>
            </li>
          ))}
        </ul>
        <div className="overflow-x-auto">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr>
                <th className="sticky left-0 bg-[#111117] px-2 py-1 text-left text-slate-500">Capability</th>
                {PLATFORM_ROLES.map((role) => (
                  <th key={role} className="px-1 py-1 font-medium text-slate-500" title={roleLabel(role)}>
                    {ROLE_SHORT[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {caps.map((cap) => (
                <tr key={cap} className="border-t border-slate-800/60">
                  <td className="sticky left-0 bg-[#111117] px-2 py-1 font-mono text-slate-300">
                    {cap}
                    {STEP_UP_CAPABILITIES.includes(cap) ? <span className="ml-1 text-amber-300" title="Needs a fresh authenticator code">●</span> : null}
                  </td>
                  {PLATFORM_ROLES.map((role) => (
                    <td key={role} className="px-1 py-1 text-center">
                      {roleCapabilities(role).includes(cap) ? <span className="text-emerald-400">✓</span> : <span className="text-slate-700">·</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500"><span className="text-amber-300">●</span> also needs a fresh authenticator code at the moment of use.</p>
      </div>
    </details>
  );
}

function MemberTable({ title, rows }: { title: string; rows: PlatformMemberRow[] }) {
  return (
    <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
      <div className="border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">MFA</th>
              <th className="px-4 py-3">Sessions</th>
              <th className="px-4 py-3">Last sign-in</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-medium">{row.profile.fullName ?? "—"}</td>
                <td className="px-4 py-3 text-slate-400">{row.profile.email}</td>
                <td className="px-4 py-3">{roleLabel(row.platformRole)}</td>
                <td className="px-4 py-3">{statusLabel(row.status)}</td>
                <td className="px-4 py-3">{row.mfaEnrolled ? "Enrolled" : row.mfaRequired ? "Required" : "Optional"}</td>
                <td className="px-4 py-3">{row.sessionCount}</td>
                <td className="px-4 py-3 text-slate-500">{row.profile.lastSignInAt ? new Date(row.profile.lastSignInAt).toLocaleDateString() : "—"}</td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/platform/access/${row.userId}`} className="text-[#F97316] hover:underline">
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">No members.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function InvitationTable({
  invitations,
  onResend,
  onRevoke,
}: {
  invitations: InvitationRow[];
  onResend: (id: string) => void;
  onRevoke: (id: string) => void;
}) {
  if (invitations.length === 0) return null;
  return (
    <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
      <div className="border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold">Pending Invitations</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Sent</th>
              <th className="px-4 py-3">Expires</th>
              <th className="px-4 py-3">Resent</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {invitations.map((inv) => (
              <tr key={inv.id}>
                <td className="px-4 py-3">{inv.full_name} · {inv.email}</td>
                <td className="px-4 py-3">{roleLabel(inv.platform_role as PlatformRole)}</td>
                <td className="px-4 py-3 text-slate-500">{new Date(inv.sent_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-slate-500">{new Date(inv.expires_at).toLocaleString()}</td>
                <td className="px-4 py-3">{inv.resent_count}</td>
                <td className="px-4 py-3 text-right space-x-3">
                  <button type="button" onClick={() => onResend(inv.id)} className="text-[#F97316]">Resend</button>
                  <button type="button" onClick={() => onRevoke(inv.id)} className="text-red-400">Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

export function MemberDetailActions({
  member,
  actorRole,
}: {
  member: PlatformMemberRow;
  actorRole: PlatformRole;
}) {
  const [pending, startTransition] = useTransition();
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { withStepUp, dialog } = useStepUp();
  const assignable = manageableRoles(actorRole);
  const canChangeRole = assignable.includes(member.platformRole) && assignable.length > 1;
  const [newRole, setNewRole] = useState<PlatformRole>(member.platformRole);

  function runAction(
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string; temporaryPassword?: string; code?: string }>,
    extra?: Record<string, string>
  ) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("user_id", member.userId);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      }
      const result = await withStepUp(() => action(fd));
      if (result.temporaryPassword) setTempPassword(result.temporaryPassword);
      setMessage(result.ok ? "Action completed." : result.error ?? "Action failed.");
    });
  }

  return (
    <div className="space-y-4">
      {dialog}
      {message ? <p className="text-sm text-slate-300">{message}</p> : null}
      {canChangeRole ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-800 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (newRole === member.platformRole) return;
            const reason = window.prompt(`Reason for changing the role to ${roleLabel(newRole)}:`);
            if (!reason) return;
            runAction(changePlatformMemberRole, { platform_role: newRole, reason });
          }}
        >
          <label className="text-sm">
            <span className="block text-xs text-slate-400">Role</span>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as PlatformRole)}
              className="mt-1 rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2"
            >
              {assignable.map((role) => (
                <option key={role} value={role}>{roleLabel(role)}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending || newRole === member.platformRole}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm disabled:opacity-50"
          >
            Change role
          </button>
          <p className="w-full text-xs text-slate-500">{ROLE_DESCRIPTIONS[newRole]} Needs your authenticator code.</p>
        </form>
      ) : null}
      {tempPassword ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold text-amber-200">Temporary password (shown once)</p>
          <p className="mt-2 font-mono text-lg">{tempPassword}</p>
          <p className="mt-2 text-xs text-slate-400">User must change password at next login. MFA still required where applicable.</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ActionButton
          disabled={pending}
          label="Reset Password"
          onClick={() => {
            const reason = window.prompt("Reason for password reset:");
            if (!reason) return;
            runAction(resetPlatformMemberPassword, { reason, revoke_sessions: "true" });
          }}
        />
        <ActionButton
          disabled={pending}
          label="Issue Temp Password"
          onClick={() => {
            const reason = window.prompt("Reason for temporary password:");
            if (!reason) return;
            runAction(issuePlatformTemporaryPassword, { reason });
          }}
        />
        <ActionButton
          disabled={pending}
          label="Revoke All Sessions"
          onClick={() => {
            const reason = window.prompt("Reason for session revocation:");
            if (!reason) return;
            runAction(revokePlatformMemberSessions, { reason });
          }}
        />
        <ActionButton
          disabled={pending}
          label="Reset MFA"
          onClick={() => {
            const reason = window.prompt("Reason for MFA reset:");
            if (!reason) return;
            runAction(resetPlatformMemberMfa, { reason });
          }}
        />
        {member.status === "ACTIVE" ? (
          <ActionButton
            disabled={pending}
            label="Suspend"
            danger
            onClick={() => {
              const reason = window.prompt("Reason for suspension:");
              if (!reason) return;
              runAction(suspendPlatformMember, { reason });
            }}
          />
        ) : (
          <ActionButton
            disabled={pending}
            label="Reactivate"
            onClick={() => runAction(reactivatePlatformMember)}
          />
        )}
        {member.status !== "REVOKED" ? (
          <ActionButton
            disabled={pending}
            label="Revoke membership"
            danger
            onClick={() => {
              const reason = window.prompt("Reason for membership revocation (does not delete the person record):");
              if (!reason) return;
              runAction(revokePlatformMembership, { reason });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-sm ${
        danger ? "border-red-500/40 text-red-300" : "border-slate-700 text-slate-200"
      }`}
    >
      {label}
    </button>
  );
}
