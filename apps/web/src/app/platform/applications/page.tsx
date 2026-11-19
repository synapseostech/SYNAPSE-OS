export const dynamic = "force-dynamic";

import Link from "next/link";
import { Building2, Kanban, Pill, UserRound } from "lucide-react";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { formatDateTime, safeCount, safeRows } from "../_lib/platform-data";
import { PlatformPageHeader } from "../_components/platform-page-header";
import { EmptyState } from "../_components/empty-state";
import { updateApplicationStatus, updateLeadStatus } from "./actions";

type ApplicationRow = {
  id?: string;
  hospital_name?: string | null;
  facility_type?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  location?: string | null;
  status?: string | null;
  created_at?: string | null;
  source?: string | null;
};

type LeadRow = {
  id?: string;
  full_name?: string;
  email?: string;
  phone?: string | null;
  hospital_name?: string | null;
  role?: string;
  location?: string | null;
  status?: string;
  created_at?: string;
  source?: string;
};

const PIPELINE_STAGES = [
  { key: "new", label: "New", statuses: ["pending", "new"] },
  { key: "reviewing", label: "Reviewing", statuses: ["reviewing", "pending_review"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "live", label: "Live", statuses: ["live", "provisioned"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected", "dormant"] },
] as const;

function stageForStatus(status: string | null | undefined, hasTenant: boolean) {
  if (hasTenant) return "live";
  const normalized = (status ?? "pending").toLowerCase();
  for (const stage of PIPELINE_STAGES) {
    if ((stage.statuses as readonly string[]).includes(normalized)) return stage.key;
  }
  return "new";
}

function daysInStage(createdAt: string | null | undefined) {
  if (!createdAt) return 0;
  const created = new Date(createdAt).getTime();
  return Math.max(0, Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000)));
}

export default async function PlatformApplicationsPage() {
  await requirePlatformPage("/platform/applications");

  const [applications, leads, pendingCount, leadCount] = await Promise.all([
    safeRows<ApplicationRow>(
      "hospital_leads",
      "id, hospital_name, facility_type, contact_name, contact_email, contact_phone, location, status, created_at, source",
      { orderBy: "created_at", limit: 100 }
    ),
    safeRows<LeadRow>(
      "professional_leads",
      "id, full_name, email, phone, hospital_name, role, location, status, created_at, source",
      { orderBy: "created_at", limit: 100 }
    ),
    safeCount("hospital_leads", [["status", "new"]]),
    safeCount("professional_leads", [["status", "new"]]),
  ]);

  type PipelineCard = {
    id: string;
    kind: "facility" | "professional";
    facilityType: "hospital" | "pharmacy" | null;
    title: string;
    subtitle: string;
    district: string;
    days: number;
    status: string;
    stage: string;
  };

  const cards: PipelineCard[] = [
    ...applications.map((row) => ({
      id: row.id ?? "",
      kind: "facility" as const,
      facilityType: row.facility_type === "pharmacy" ? ("pharmacy" as const) : ("hospital" as const),
      title: row.hospital_name ?? row.contact_name ?? "Unnamed facility",
      subtitle: row.contact_email ?? "",
      district: row.location ?? "—",
      days: daysInStage(row.created_at),
      status: row.status ?? "new",
      stage: stageForStatus(row.status, false),
    })),
    ...leads.map((row) => ({
      id: row.id ?? "",
      kind: "professional" as const,
      facilityType: null,
      title: row.full_name ?? "Unknown",
      subtitle: row.email ?? "",
      district: row.location ?? "—",
      days: daysInStage(row.created_at),
      status: row.status ?? "new",
      stage: stageForStatus(row.status, false),
    })),
  ];

  const columns = PIPELINE_STAGES.map((stage) => ({
    ...stage,
    cards: cards.filter((card) => card.stage === stage.key),
  }));

  const totalPipeline = cards.length;

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Growth"
        title="Applications pipeline"
        description="Track facility interest and professional leads from first touch through approval and go-live."
        actions={
          <Link
            href="/platform/approvals"
            className="inline-flex items-center gap-2 rounded-xl border border-subtle px-4 py-2.5 text-sm font-medium text-secondary-color transition hover:border-[#F97316]/30 hover:text-primary-color"
          >
            KYC & verifications
          </Link>
        }
      />

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          ["Pipeline total", totalPipeline],
          ["Pending facility apps", pendingCount],
          ["New professional leads", leadCount],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-xl border border-subtle bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-color">{label}</p>
            <p className="mt-2 font-display text-2xl font-bold tabular-nums text-[#F97316]">
              {Number(value).toLocaleString()}
            </p>
          </article>
        ))}
      </section>

      {totalPipeline === 0 ? (
        <EmptyState
          icon={Kanban}
          title="No applications yet"
          description="When facilities apply via the landing page or professionals submit interest, they will appear here as pipeline cards."
          action={
            <Link href="/apply/pharmacy" className="text-sm font-semibold text-[#F97316]">
              View public apply form →
            </Link>
          }
        />
      ) : (
        <section className="overflow-x-auto pb-2">
          <div className="flex min-w-max gap-4">
            {columns.map((column) => (
              <div key={column.key} className="w-72 shrink-0">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-primary-color">{column.label}</h2>
                  <span className="rounded-full border border-subtle bg-base px-2 py-0.5 text-xs tabular-nums text-muted-color">
                    {column.cards.length}
                  </span>
                </div>
                <div className="space-y-2 rounded-xl border border-subtle bg-surface/50 p-2 min-h-[240px]">
                  {column.cards.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-color">Empty</p>
                  ) : (
                    column.cards.map((card) => (
                      <article key={`${card.kind}-${card.id}`} className="rounded-lg border border-subtle bg-base p-3">
                        <div className="flex items-start gap-2">
                          {card.kind === "professional" ? (
                            <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-[#1FA6A6]" />
                          ) : card.facilityType === "pharmacy" ? (
                            <Pill className="mt-0.5 h-4 w-4 shrink-0 text-[#1FA6A6]" />
                          ) : (
                            <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-[#E8B84B]" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="truncate text-sm font-semibold text-primary-color">{card.title}</p>
                              {card.kind === "facility" ? (
                                <span className="shrink-0 rounded-full border border-subtle px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-color">
                                  {card.facilityType === "pharmacy" ? "Pharmacy" : "Hospital"}
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-xs text-muted-color">{card.subtitle}</p>
                            <p className="mt-1 text-[10px] text-muted-color">
                              {card.district} · {card.days}d in stage
                            </p>
                          </div>
                        </div>
                        {column.key !== "live" && column.key !== "rejected" ? (
                          <div className="mt-3 flex flex-wrap gap-1">
                            {column.key === "new" ? (
                              <form action={card.kind === "facility" ? updateApplicationStatus : updateLeadStatus}>
                                <input type="hidden" name="id" value={card.id} />
                                <input type="hidden" name="status" value={card.kind === "facility" ? "reviewing" : "reviewing"} />
                                <button type="submit" className="rounded border border-subtle px-2 py-0.5 text-[10px] text-secondary-color hover:border-[#F97316]/30">
                                  Review
                                </button>
                              </form>
                            ) : null}
                            {column.key === "reviewing" ? (
                              <>
                                <form action={card.kind === "facility" ? updateApplicationStatus : updateLeadStatus}>
                                  <input type="hidden" name="id" value={card.id} />
                                  <input type="hidden" name="status" value="approved" />
                                  <button type="submit" className="rounded border border-green-500/30 px-2 py-0.5 text-[10px] text-green-300">
                                    Approve
                                  </button>
                                </form>
                                <form action={card.kind === "facility" ? updateApplicationStatus : updateLeadStatus}>
                                  <input type="hidden" name="id" value={card.id} />
                                  <input type="hidden" name="status" value="rejected" />
                                  <button type="submit" className="rounded border border-red-500/30 px-2 py-0.5 text-[10px] text-red-300">
                                    Reject
                                  </button>
                                </form>
                              </>
                            ) : null}
                            {column.key === "approved" ? (
                              <Link
                                href={
                                  card.kind === "professional"
                                    ? "/platform/approvals"
                                    : card.facilityType === "pharmacy"
                                      ? "/platform/pharmacies/onboard"
                                      : `/platform/hospitals/new?name=${encodeURIComponent(card.title)}&email=${encodeURIComponent(card.subtitle)}&location=${encodeURIComponent(card.district)}`
                                }
                                className="rounded border border-[#F97316]/30 px-2 py-0.5 text-[10px] text-[#F97316]"
                              >
                                Provision →
                              </Link>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-subtle bg-surface">
        <div className="border-b border-subtle px-4 py-3">
          <h2 className="text-sm font-semibold text-primary-color">Recent applications (list view)</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-subtle text-left text-xs uppercase tracking-wide text-muted-color">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">District</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {cards.slice(0, 20).map((card) => (
                <tr key={`${card.kind}-${card.id}`}>
                  <td className="px-4 py-3 font-medium text-primary-color">{card.title}</td>
                  <td className="px-4 py-3 capitalize text-secondary-color">
                    {card.kind === "professional" ? "Professional" : card.facilityType === "pharmacy" ? "Pharmacy" : "Hospital"}
                  </td>
                  <td className="px-4 py-3 text-secondary-color">{card.district}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-subtle px-2 py-0.5 text-xs capitalize">{card.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-color">
                    {formatDateTime(
                      card.kind === "facility"
                        ? applications.find((a) => a.id === card.id)?.created_at
                        : leads.find((l) => l.id === card.id)?.created_at
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
