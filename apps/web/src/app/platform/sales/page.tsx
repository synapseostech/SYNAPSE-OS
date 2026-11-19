export const dynamic = "force-dynamic";

import { createServiceClient } from "../../../lib/supabase/server";
import { requirePlatformAccess, requirePlatformPage } from "../../../lib/platform/auth";

const STAGES = [
  { key: "interest", label: "Interest" },
  { key: "demo", label: "Demo Scheduled" },
  { key: "trial", label: "Trial Active" },
  { key: "converted", label: "Converted" },
] as const;

async function createLead(formData: FormData) {
  "use server";
  await requirePlatformAccess("platform.crm.manage");
  const supabaseAdmin = createServiceClient();

  const hospital_name = String(formData.get("hospital_name") ?? "").trim();
  if (!hospital_name) {
    return;
  }

  await (supabaseAdmin as any).from("hospital_leads").insert({
    hospital_name,
    contact_name: String(formData.get("contact_name") ?? ""),
    contact_email: String(formData.get("contact_email") ?? ""),
    contact_phone: String(formData.get("contact_phone") ?? ""),
    location: String(formData.get("location") ?? ""),
    notes: String(formData.get("notes") ?? ""),
    stage: "interest",
    source: "outreach",
  });
}

async function updateStage(formData: FormData) {
  "use server";
  await requirePlatformAccess("platform.crm.manage");
  const id = String(formData.get("id") ?? "");
  const stage = String(formData.get("stage") ?? "interest");
  if (!id) {
    return;
  }

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any)
    .from("hospital_leads")
    .update({ stage, updated_at: new Date().toISOString() })
    .eq("id", id);
}

export default async function PlatformSalesPage() {
  await requirePlatformPage("/platform/sales");
  const supabaseAdmin = createServiceClient();

  const { data: leads } = await (supabaseAdmin as any)
    .from("hospital_leads")
    .select("id, hospital_name, contact_name, contact_email, location, notes, stage, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  const grouped = new Map<string, any[]>();
  STAGES.forEach((stage) => grouped.set(stage.key, []));
  (leads ?? []).forEach((lead: any) => {
    if (grouped.has(lead.stage)) {
      grouped.get(lead.stage)?.push(lead);
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Sales Pipeline</h1>
          <p className="text-sm text-slate-400">Track hospital conversion from first contact to paid activation.</p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Add Lead</h2>
        <form action={createLead} className="mt-3 grid gap-2 md:grid-cols-2">
          <input name="hospital_name" placeholder="Hospital name" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" required />
          <input name="location" placeholder="Location" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <input name="contact_name" placeholder="Contact name" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <input name="contact_email" placeholder="Contact email" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <input name="contact_phone" placeholder="Contact phone" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <input name="notes" placeholder="Notes" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <div className="md:col-span-2">
            <button type="submit" className="rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A]">Add lead</button>
          </div>
        </form>
      </section>

      <section className="grid gap-3 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <div key={stage.key} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">{stage.label}</h3>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                {(grouped.get(stage.key) ?? []).length}
              </span>
            </div>
            <div className="space-y-2">
              {(grouped.get(stage.key) ?? []).map((lead) => (
                <article key={lead.id} className="rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm">
                  <p className="font-semibold text-slate-100">{lead.hospital_name}</p>
                  <p className="text-xs text-slate-400">{lead.contact_name || "No contact"} · {lead.location || "No location"}</p>
                  <p className="mt-2 text-xs text-slate-500 line-clamp-3">{lead.notes || "No notes yet."}</p>
                  <form action={updateStage} className="mt-2 flex gap-2">
                    <input type="hidden" name="id" value={lead.id} />
                    <select name="stage" defaultValue={lead.stage} className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs">
                      {STAGES.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300">Move</button>
                  </form>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
