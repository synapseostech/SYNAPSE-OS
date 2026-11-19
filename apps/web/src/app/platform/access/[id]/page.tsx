export const dynamic = "force-dynamic";

import Link from "next/link";
import { supabaseAdmin } from "@synapse/db/admin";
import { requirePlatformPage } from "@/lib/platform/auth";
import { getPlatformMember } from "@/lib/platform/membership.server";
import { roleLabel, statusLabel } from "@/lib/platform/rbac";
import { MemberDetailActions } from "../PlatformAccessClient";
import { formatDate } from "../../_lib/platform-data";

export default async function PlatformMemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requirePlatformPage("/platform/access/[id]");
  const { id } = await params;
  const member = await getPlatformMember(id);

  if (!member) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#111117] p-8 text-center">
        <p className="text-slate-400">Platform member not found.</p>
        <Link href="/platform/access" className="mt-4 inline-block text-[#F97316]">← Back to Platform Access</Link>
      </div>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data: sessions } = await db
    .from("synapse_sessions")
    .select("id, app, created_at, last_used_at, expires_at, revoked_at")
    .eq("user_id", id)
    .is("revoked_at", null)
    .order("last_used_at", { ascending: false })
    .limit(20);

  const { data: auditRows } = await db
    .from("audit_log")
    .select("action, created_at, new_value")
    .eq("user_id", id)
    .order("created_at", { ascending: false })
    .limit(15);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/platform/access" className="text-xs text-slate-500 hover:text-[#F97316]">← Platform Access</Link>
          <h1 className="mt-2 text-2xl font-bold">{member.profile.fullName ?? member.profile.email}</h1>
          <p className="text-sm text-slate-400">{member.profile.email}</p>
        </div>
        <span className="rounded-full border border-slate-700 px-3 py-1 text-xs">{statusLabel(member.status)}</span>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border border-slate-800 bg-[#111117] p-5 space-y-3">
          <h2 className="text-sm font-semibold">Identity</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">Role</dt><dd>{roleLabel(member.platformRole)}</dd>
            <dt className="text-slate-500">MFA</dt><dd>{member.mfaEnrolled ? "Enrolled" : member.mfaRequired ? "Required — not enrolled" : "Optional"}</dd>
            <dt className="text-slate-500">Joined</dt><dd>{formatDate(member.acceptedAt ?? member.invitedAt)}</dd>
            <dt className="text-slate-500">Last sign-in</dt><dd>{formatDate(member.profile.lastSignInAt)}</dd>
            <dt className="text-slate-500">Expires</dt><dd>{member.expiresAt ? formatDate(member.expiresAt) : "No expiry"}</dd>
          </dl>
        </article>

        <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 className="text-sm font-semibold">Security Actions</h2>
          <p className="mt-1 text-xs text-slate-500">Passwords are never displayed except one-time temporary credentials.</p>
          <div className="mt-4">
            <MemberDetailActions member={member} actorRole={actor.platformRole} />
          </div>
        </article>
      </section>

      <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <h2 className="text-sm font-semibold">Active Sessions</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-4">App</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Last used</th>
                <th className="py-2">Expires</th>
              </tr>
            </thead>
            <tbody>
              {(sessions ?? []).map((s: { id: string; app: string; created_at: string; last_used_at: string | null; expires_at: string }) => (
                <tr key={s.id} className="border-t border-slate-800">
                  <td className="py-2 pr-4">{s.app}</td>
                  <td className="py-2 pr-4 text-slate-500">{formatDate(s.created_at)}</td>
                  <td className="py-2 pr-4 text-slate-500">{formatDate(s.last_used_at)}</td>
                  <td className="py-2 text-slate-500">{formatDate(s.expires_at)}</td>
                </tr>
              ))}
              {!sessions?.length ? (
                <tr><td colSpan={4} className="py-4 text-slate-500">No active sessions.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </article>

      <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <h2 className="text-sm font-semibold">Recent Audit</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {(auditRows ?? []).map((row: { action: string; created_at: string }, i: number) => (
            <li key={`${row.action}-${i}`} className="flex justify-between border-b border-slate-800/60 pb-2">
              <span>{row.action}</span>
              <span className="text-slate-500">{formatDate(row.created_at)}</span>
            </li>
          ))}
          {!auditRows?.length ? <li className="text-slate-500">No audit entries for this user.</li> : null}
        </ul>
      </article>
    </div>
  );
}
