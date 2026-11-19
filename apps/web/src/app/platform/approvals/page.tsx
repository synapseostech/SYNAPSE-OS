export const dynamic = "force-dynamic";

import { createServiceClient } from "../../../lib/supabase/server";
import { requirePlatformAccess, requirePlatformPage } from "../../../lib/platform/auth";

async function updatePilotStatus(formData: FormData) {
  "use server";
  await requirePlatformAccess("tenant.manage");
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "pending");
  if (!id) {
    return;
  }

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any).from("hospital_leads").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
}

async function updateVerificationStatus(formData: FormData) {
  "use server";
  await requirePlatformAccess("tenant.manage");
  const profileId = String(formData.get("profile_id") ?? "");
  const status = String(formData.get("status") ?? "pending_review");
  if (!profileId) {
    return;
  }

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any).from("profiles").update({ verification_status: status }).eq("id", profileId);
}

export default async function PlatformApprovalsPage() {
  await requirePlatformPage("/platform/approvals");
  const supabaseAdmin = createServiceClient();

  const [{ data: pilotApplications }, { data: verifications }] = await Promise.all([
    (supabaseAdmin as any)
      .from("hospital_leads")
      .select("id, hospital_name, facility_type, contact_name, contact_email, notes, created_at, status")
      .order("created_at", { ascending: false })
      .limit(50),
    (supabaseAdmin as any)
      .from("verification_documents")
      .select("id, profile_id, document_type, storage_path, status, ai_analysis, created_at, profiles(full_name, specialty, license_number)")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Approval Queues</h1>
        <p className="text-sm text-slate-400">Pilot applications and medical professional verification workflow.</p>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">Pilot Applications</h2>
        <div className="space-y-2">
          {(pilotApplications ?? []).map((item: any) => (
            <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-100">
                    {item.hospital_name ?? "Unnamed facility"}{" "}
                    <span className="ml-1 rounded-full border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                      {item.facility_type === "pharmacy" ? "Pharmacy" : "Hospital"}
                    </span>
                  </p>
                  <p className="text-xs text-slate-400">{item.contact_name} · {item.contact_email}</p>
                  <p className="mt-2 text-sm text-slate-300">{item.notes ?? "No message"}</p>
                </div>
                <div className="text-right text-xs text-slate-500">{new Date(item.created_at).toLocaleString()}</div>
              </div>
              <div className="mt-3 flex gap-2">
                <form action={updatePilotStatus}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="status" value="approved" />
                  <button className="rounded-lg border border-emerald-500/40 px-2 py-1 text-xs text-emerald-300">Approve</button>
                </form>
                <form action={updatePilotStatus}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="status" value="rejected" />
                  <button className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-300">Reject</button>
                </form>
              </div>
            </div>
          ))}
          {(pilotApplications ?? []).length === 0 ? <p className="text-sm text-slate-500">No pilot applications pending.</p> : null}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">Professional Verifications</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {(verifications ?? []).map((item: any) => (
            <article key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
              <p className="font-semibold text-slate-100">{item.profiles?.full_name ?? "Unknown applicant"}</p>
              <p className="text-xs text-slate-400">Specialty: {item.profiles?.specialty ?? "-"}</p>
              <p className="text-xs text-slate-400">License: {item.profiles?.license_number ?? "-"}</p>
              <p className="mt-2 text-xs text-slate-500">Doc type: {item.document_type}</p>
              <p className="text-xs text-slate-500">Status: {item.status}</p>
              <p className="mt-2 rounded-lg border border-slate-700 bg-slate-900/70 px-2 py-1 text-xs text-slate-400">
                AI: {item.ai_analysis ? JSON.stringify(item.ai_analysis).slice(0, 180) : "No AI analysis"}
              </p>

              <div className="mt-3 flex gap-2">
                <form action={updateVerificationStatus}>
                  <input type="hidden" name="profile_id" value={item.profile_id} />
                  <input type="hidden" name="status" value="verified" />
                  <button className="rounded-lg border border-emerald-500/40 px-2 py-1 text-xs text-emerald-300">Approve</button>
                </form>
                <form action={updateVerificationStatus}>
                  <input type="hidden" name="profile_id" value={item.profile_id} />
                  <input type="hidden" name="status" value="pending_more_info" />
                  <button className="rounded-lg border border-amber-500/40 px-2 py-1 text-xs text-amber-300">Request info</button>
                </form>
                <form action={updateVerificationStatus}>
                  <input type="hidden" name="profile_id" value={item.profile_id} />
                  <input type="hidden" name="status" value="rejected" />
                  <button className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-300">Reject</button>
                </form>
              </div>
            </article>
          ))}
          {(verifications ?? []).length === 0 ? <p className="text-sm text-slate-500">No verification documents found.</p> : null}
        </div>
      </section>
    </div>
  );
}
