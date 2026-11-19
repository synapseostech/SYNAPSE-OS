export const dynamic = "force-dynamic";

import { AlertTriangle, Lock, ShieldCheck, ShieldOff, UserX, Zap } from "lucide-react";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { createServiceClient } from "../../../lib/supabase/server";
import { formatDateTime } from "../_lib/platform-data";

type LockedProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  login_attempts: number | null;
  locked_until: string | null;
  tenant_id: string | null;
};

type HighRiskProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  login_attempts: number | null;
  locked_until: string | null;
};

type SecurityEvent = {
  id: string;
  action: string | null;
  table_name: string | null;
  user_id: string | null;
  tenant_id: string | null;
  new_value: Record<string, unknown> | null;
  created_at: string | null;
};

type ActorProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
};

function safeRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

const SECURITY_ACTIONS = [
  "pharmacy.credentials_resent",
  "pharmacy.setup_invite_resent",
  "pharmacy.setup_invite_failed",
  "pharmacy.admin_profile_failed",
  "pharmacy.credentials_email_failed",
  "pharmacy.suspended",
  "pharmacy.deleted",
  "user.locked",
  "user.password_reset",
  "auth.failed",
  "auth.locked",
  "auth.mfa_failed",
];

function severityBadge(action: string) {
  if (action.includes("delete") || action.includes("suspend") || action.includes("locked") || action.includes("failed"))
    return "border-red-500/30 bg-red-500/10 text-red-300";
  if (action.includes("reset") || action.includes("resent"))
    return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
  return "border-[#E8B84B]/20 bg-[#E8B84B]/10 text-[#E8B84B]";
}

export default async function SecurityPage() {
  await requirePlatformPage("/platform/security");
  const db = createServiceClient() as any;
  const now = new Date().toISOString();

  const [
    { data: lockedRaw },
    { data: highRiskRaw },
    { data: eventsRaw },
  ] = await Promise.all([
    db.from("profiles")
      .select("id, email, full_name, role, login_attempts, locked_until, tenant_id")
      .gt("locked_until", now)
      .order("locked_until", { ascending: false })
      .limit(50),

    db.from("profiles")
      .select("id, email, full_name, role, login_attempts, locked_until")
      .gte("login_attempts", 3)
      .or(`locked_until.is.null,locked_until.lte.${now}`)
      .order("login_attempts", { ascending: false })
      .limit(50),

    db.from("audit_log")
      .select("id, action, table_name, user_id, tenant_id, new_value, created_at")
      .or(SECURITY_ACTIONS.map((a) => `action.eq.${a}`).join(","))
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const locked = safeRows<LockedProfile>(lockedRaw);
  const highRisk = safeRows<HighRiskProfile>(highRiskRaw);
  const events = safeRows<SecurityEvent>(eventsRaw);

  // Fetch actor emails for events
  const actorIds = [...new Set(events.map((e) => e.user_id).filter(Boolean))] as string[];
  const { data: actorsRaw } = actorIds.length > 0
    ? await db.from("profiles").select("id, email, full_name").in("id", actorIds)
    : { data: [] };
  const actorMap = new Map<string, ActorProfile>(
    safeRows<ActorProfile>(actorsRaw).map((a) => [a.id, a])
  );

  const totalThreats = locked.length + highRisk.length;

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Platform Security</p>
        <h1 className="mt-2 text-2xl font-bold">Security Monitor</h1>
        <p className="mt-1 text-sm text-slate-400">Live view of login failures, account lockouts, and security events across all tenants.</p>
      </section>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-400">Locked Accounts</p>
            <Lock className="h-4 w-4 text-red-400" />
          </div>
          <p className="mt-2 text-3xl font-bold text-red-300">{locked.length}</p>
          <p className="mt-1 text-xs text-slate-500">Currently locked out</p>
        </div>

        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-yellow-400">High Failure Accounts</p>
            <AlertTriangle className="h-4 w-4 text-yellow-400" />
          </div>
          <p className="mt-2 text-3xl font-bold text-yellow-300">{highRisk.length}</p>
          <p className="mt-1 text-xs text-slate-500">3+ failed attempts, not locked</p>
        </div>

        <div className="rounded-xl border border-[#E8B84B]/20 bg-[#E8B84B]/5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#E8B84B]">Security Events</p>
            <Zap className="h-4 w-4 text-[#E8B84B]" />
          </div>
          <p className="mt-2 text-3xl font-bold text-[#E8B84B]">{events.length}</p>
          <p className="mt-1 text-xs text-slate-500">Last 100 logged</p>
        </div>

        <div className={`rounded-xl border p-4 ${totalThreats === 0 ? "border-green-500/20 bg-green-500/5" : "border-orange-500/20 bg-orange-500/5"}`}>
          <div className="flex items-center justify-between">
            <p className={`text-xs font-semibold uppercase tracking-wide ${totalThreats === 0 ? "text-green-400" : "text-orange-400"}`}>Overall Status</p>
            {totalThreats === 0 ? <ShieldCheck className="h-4 w-4 text-green-400" /> : <ShieldOff className="h-4 w-4 text-orange-400" />}
          </div>
          <p className={`mt-2 text-lg font-bold ${totalThreats === 0 ? "text-green-300" : "text-orange-300"}`}>
            {totalThreats === 0 ? "All Clear" : `${totalThreats} Issues`}
          </p>
          <p className="mt-1 text-xs text-slate-500">{totalThreats === 0 ? "No active threats detected" : "Review accounts below"}</p>
        </div>
      </div>

      {/* Locked accounts */}
      <section className="rounded-xl border border-red-500/20 bg-[#111117]">
        <div className="flex items-center gap-3 border-b border-red-500/20 px-5 py-4">
          <Lock className="h-4 w-4 text-red-400" />
          <h2 className="font-semibold text-red-300">Locked Accounts</h2>
          <span className="ml-auto rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">{locked.length}</span>
        </div>
        {locked.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-8 text-sm text-slate-500">
            <ShieldCheck className="h-5 w-5 text-green-500" />
            No accounts currently locked.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">Account</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Attempts</th>
                  <th className="px-5 py-3 font-medium">Locked Until</th>
                  <th className="px-5 py-3 font-medium">Unlock</th>
                </tr>
              </thead>
              <tbody>
                {locked.map((p) => (
                  <tr key={p.id} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-200">{p.full_name ?? "—"}</p>
                      <p className="text-xs text-slate-500">{p.email}</p>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-400">{p.role ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">
                        {p.login_attempts ?? 0}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-400">
                      {p.locked_until ? formatDateTime(p.locked_until) : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <form action={`/api/platform/security/unlock`} method="POST">
                        <input type="hidden" name="profile_id" value={p.id} />
                        <button
                          type="submit"
                          className="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-300 hover:border-green-500/40 hover:text-green-300"
                        >
                          Unlock
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* High-risk accounts */}
      {highRisk.length > 0 && (
        <section className="rounded-xl border border-yellow-500/20 bg-[#111117]">
          <div className="flex items-center gap-3 border-b border-yellow-500/20 px-5 py-4">
            <UserX className="h-4 w-4 text-yellow-400" />
            <h2 className="font-semibold text-yellow-300">High Failure Rate — Not Locked</h2>
            <span className="ml-auto rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-300">{highRisk.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">Account</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Failed Attempts</th>
                </tr>
              </thead>
              <tbody>
                {highRisk.map((p) => (
                  <tr key={p.id} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-200">{p.full_name ?? "—"}</p>
                      <p className="text-xs text-slate-500">{p.email}</p>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-400">{p.role ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-300">
                        {p.login_attempts} attempts
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Security event log */}
      <section className="rounded-xl border border-slate-800 bg-[#111117]">
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
          <Zap className="h-4 w-4 text-[#E8B84B]" />
          <h2 className="font-semibold">Security Event Log</h2>
          <span className="ml-auto text-xs text-slate-500">{events.length} events</span>
        </div>
        {events.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No security events recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">Event</th>
                  <th className="px-5 py-3 font-medium">Actor</th>
                  <th className="px-5 py-3 font-medium">Details</th>
                  <th className="px-5 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const actor = e.user_id ? actorMap.get(e.user_id) : null;
                  const action = e.action ?? "unknown";
                  return (
                    <tr key={e.id} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                      <td className="px-5 py-3">
                        <span className={`rounded-full border px-2 py-0.5 text-xs ${severityBadge(action)}`}>
                          {action}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {actor ? (
                          <div>
                            <p className="text-xs text-slate-300">{actor.full_name ?? actor.email}</p>
                            <p className="text-xs text-slate-500">{actor.email}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">system</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {e.new_value && Object.keys(e.new_value).length > 0
                          ? Object.entries(e.new_value)
                              .filter(([, v]) => v !== null && v !== undefined)
                              .slice(0, 2)
                              .map(([k, v]) => `${k}: ${String(v)}`)
                              .join(" · ")
                          : e.table_name ?? "—"}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {e.created_at ? formatDateTime(e.created_at) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
