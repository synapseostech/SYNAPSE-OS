export const dynamic = "force-dynamic";

import { Megaphone, Radio, Send, Siren } from "lucide-react";
import { createServiceClient } from "../../../lib/supabase/server";
import { requirePlatformAccess, requirePlatformPage } from "../../../lib/platform/auth";
import { formatDate, safeCount, safeRows } from "../_lib/platform-data";
import { UserBroadcastClient } from "./UserBroadcastClient";
import { sendEmailBroadcast, sendSmsBroadcast } from "./actions";

type BulletinRow = {
  id?: string;
  title?: string | null;
  severity?: string | null;
  target_audience?: string | null;
  target_scope?: string | null;
  status?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
  published_at?: string | null;
};

async function publishBulletin(formData: FormData) {
  "use server";
  const profile = await requirePlatformAccess("platform.crm.manage");

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const severity = String(formData.get("severity") ?? "info");
  const target = String(formData.get("target") ?? "all_uganda");
  const expiresAt = String(formData.get("expires_at") ?? "");

  if (!title || !body) return;

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any).from("health_bulletins").insert({
    title,
    body,
    severity,
    target_audience: target,
    target_scope: target,
    status: "published",
    created_by: profile.id,
    published_at: new Date().toISOString(),
    expires_at: expiresAt || null,
  });

  const { notifyPlatformBroadcast } = await import("@synapse/auth/mobile-push");
  notifyPlatformBroadcast({ title, body, severity });
}

function severityClass(severity: string | null | undefined) {
  if (severity === "critical") return "border-red-500/30 bg-red-500/10 text-red-300";
  if (severity === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-[#F97316]/25 bg-[#F97316]/10 text-[#F97316]";
}

export default async function PlatformBroadcastsPage() {
  await requirePlatformPage("/platform/broadcasts");

  const db = createServiceClient() as any;

  const [bulletins, activeBulletins, draftBulletins, criticalBulletins, allUsersResult, roleRowsResult] =
    await Promise.all([
      safeRows<BulletinRow>(
        "health_bulletins",
        "id, title, severity, target_audience, target_scope, status, expires_at, created_at, published_at",
        { orderBy: "created_at", limit: 80 }
      ),
      safeCount("health_bulletins", [["status", "published"]]),
      safeCount("health_bulletins", [["status", "draft"]]),
      safeCount("health_bulletins", [["severity", "critical"]]),
      db.from("profiles").select("id", { count: "exact", head: true }),
      db.from("profiles").select("role").not("role", "is", null).limit(5000),
    ]);

  const totalUsers: number = (allUsersResult as any)?.count ?? 0;

  const roleCountMap: Record<string, number> = {};
  for (const row of ((roleRowsResult as any)?.data ?? []) as { role: string }[]) {
    if (row.role) roleCountMap[row.role] = (roleCountMap[row.role] ?? 0) + 1;
  }

  let hasPhoneColumn = false;
  try {
    const { error } = await db.from("profiles").select("phone").limit(1);
    hasPhoneColumn = !error || !(error.message ?? "").includes("phone");
  } catch {
    hasPhoneColumn = false;
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Communications</p>
          <h1 className="mt-2 text-2xl font-bold">Broadcasts</h1>
          <p className="mt-1 text-sm text-slate-400">
            Health bulletins for facilities and patient app · Direct email and SMS to platform users.
          </p>
        </div>
        <div className="rounded-xl border border-[#E8B84B]/30 bg-[#E8B84B]/10 px-4 py-2 text-sm font-semibold text-[#E8B84B]">
          Critical SMS path prepared
        </div>
      </section>

      {/* Stats */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            ["Total bulletins", bulletins.length],
            ["Published", activeBulletins],
            ["Drafts", draftBulletins],
            ["Critical", criticalBulletins],
          ] as [string, number][]
        ).map(([label, value]) => (
          <article key={label} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-[#F97316]">{Number(value).toLocaleString()}</p>
          </article>
        ))}
      </section>

      {/* Direct user comms — email & SMS tabs */}
      <UserBroadcastClient
        roleCounts={roleCountMap}
        totalUsers={totalUsers}
        hasPhoneColumn={hasPhoneColumn}
        sendEmail={sendEmailBroadcast}
        sendSms={sendSmsBroadcast}
      />

      {/* Health bulletin composer + list */}
      <section className="grid gap-4 xl:grid-cols-[420px_1fr]">
        <form action={publishBulletin} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <div className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="text-sm font-semibold">Health Bulletin Composer</h2>
          </div>
          <div className="mt-4 space-y-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Title
              <input name="title" required className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#F97316]" />
            </label>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Body
              <textarea name="body" required rows={7} className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#F97316]" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                Severity
                <select name="severity" className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-100">
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                Target
                <select name="target" className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-100">
                  <option value="all_uganda">All Uganda</option>
                  <option value="districts">Select districts</option>
                  <option value="facilities">All facilities</option>
                  <option value="patient_app">Patient app users</option>
                </select>
              </label>
            </div>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Expiry date
              <input name="expires_at" type="date" className="mt-1 w-full rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-100" />
            </label>
            <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#F97316] px-4 py-2 text-sm font-semibold text-white hover:bg-[#EA6C0A]">
              <Send className="h-4 w-4" />
              Publish bulletin
            </button>
          </div>
        </form>

        <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
            <div>
              <h2 className="text-sm font-semibold">Bulletins List</h2>
              <p className="mt-1 text-xs text-slate-500">Active bulletins, drafts, and expired notices.</p>
            </div>
            <Radio className="h-4 w-4 text-[#E8B84B]" />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Published</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {bulletins.map((bulletin) => (
                  <tr key={bulletin.id ?? bulletin.title}>
                    <td className="px-4 py-3 font-medium text-slate-100">{bulletin.title ?? "Untitled"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${severityClass(bulletin.severity)}`}>
                        {bulletin.severity ?? "info"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{bulletin.target_audience ?? bulletin.target_scope ?? "all_uganda"}</td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(bulletin.published_at ?? bulletin.created_at)}</td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(bulletin.expires_at)}</td>
                    <td className="px-4 py-3 text-slate-300">{bulletin.status ?? "draft"}</td>
                  </tr>
                ))}
                {bulletins.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-500">No health bulletins yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="rounded-xl border border-red-500/25 bg-red-500/10 p-4">
        <div className="flex items-center gap-2 text-red-100">
          <Siren className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Outbreak Escalation Path</h2>
        </div>
        <p className="mt-2 text-sm text-red-200/80">
          SynapseEPI outbreak alerts can prefill this composer so platform admins can publish critical notices immediately.
        </p>
      </section>
    </div>
  );
}
