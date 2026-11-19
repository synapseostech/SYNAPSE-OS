export const dynamic = "force-dynamic";

import Link from "next/link";
import { requirePlatformPage } from "../../lib/platform/auth";
import {
  checkDatabaseLatency,
  dailyCountsFromRows,
  formatDateTime,
  formatUGX,
  lastNDays,
  loadSubscriptionData,
  percentDelta,
  safeCount,
  safeRows,
} from "./_lib/platform-data";
import { OverviewCommandCenter, type OverviewCommandCenterData, type ProductionTruthCard } from "./_components/overview-command-center";
import { PRODUCT_MANIFEST, overallPlatformHealth, statusLabel } from "@synapse/config/manifest";
import { getProductionTruth } from "../../lib/platform/production-truth";
import { getHospitalPilotRc1Pulse } from "../../lib/platform/rc1-pulse";

type TenantRow = {
  id?: string;
  created_at?: string | null;
  status?: string | null;
  facility_type?: string | null;
  district?: string | null;
};
type ProfileRow = { id?: string; created_at?: string | null; role?: string | null };
type AuditRow = {
  id?: string;
  action?: string | null;
  table_name?: string | null;
  record_id?: string | null;
  user_id?: string | null;
  user_role?: string | null;
  tenant_id?: string | null;
  created_at?: string | null;
  new_value?: Record<string, unknown> | null;
};
type ApplicationRow = {
  id?: string;
  hospital_name?: string | null;
  facility_type?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  location?: string | null;
  status?: string | null;
  created_at?: string | null;
};
type LeadRow = {
  id?: string;
  full_name?: string;
  email?: string;
  hospital_name?: string | null;
  role?: string;
  location?: string | null;
  status?: string;
  created_at?: string;
};
type OnboardingRow = { tenant_id?: string | null; current_step?: number | null };
type TicketRow = { id?: string; subject?: string | null; status?: string | null; created_at?: string | null };

function sumWindow(values: number[], start: number, end: number) {
  return values.slice(start, end).reduce((sum, value) => sum + value, 0);
}

function truthCardStatus(
  kind: "db" | "openrouter" | "icd11" | "sha" | "github" | "module",
  value: string
): ProductionTruthCard["status"] {
  const upper = value.toUpperCase();
  if (kind === "db") {
    if (upper.includes("OPERATIONAL")) return "green";
    if (upper.includes("DEGRADED")) return "amber";
    return "red";
  }
  if (kind === "openrouter") {
    if (upper.includes("HEALTHY")) return "green";
    if (upper.includes("NOT_CONFIGURED")) return "slate";
    return "red";
  }
  if (kind === "icd11") {
    if (upper.includes("HEALTHY")) return "green";
    if (upper.includes("CACHE")) return "amber";
    if (upper.includes("NOT_CONFIGURED")) return "slate";
    return "amber";
  }
  if (kind === "sha") {
    if (upper.includes("MATCH")) return "green";
    if (upper.includes("BEHIND")) return "amber";
    return "slate";
  }
  if (kind === "github") {
    if (upper.includes("HEALTHY")) return "green";
    if (upper.includes("NOT_CONFIGURED")) return "slate";
    return "amber";
  }
  return "slate";
}

async function getOverviewData(): Promise<OverviewCommandCenterData> {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [
    productionTruth,
    dbHealth,
    activeFacilities,
    totalUsers,
    liveSessions,
    pendingKyc,
    openTickets,
    pendingApplications,
    tenants,
    recentTenants,
    recentProfiles,
    transactionRows,
    subData,
    auditRows,
    applications,
    professionalLeads,
    onboardingRows,
    openTicketRows,
  ] = await Promise.all([
    getProductionTruth(),
    checkDatabaseLatency(),
    safeCount("tenants", [["status", "active"]]),
    safeCount("profiles"),
    safeCount("synapse_sessions"),
    safeCount("verification_documents", [["status", "pending_review"]]),
    safeCount("support_tickets", [["status", "open"]]),
    safeCount("hospital_leads", [["status", "new"]]),
    safeRows<TenantRow>("tenants", "id, created_at, status, facility_type, district", { orderBy: "created_at", limit: 500 }),
    safeRows<TenantRow>("tenants", "id, created_at", { orderBy: "created_at", limit: 500 }),
    safeRows<ProfileRow>("profiles", "id, created_at", { orderBy: "created_at", limit: 500 }),
    safeRows<{ created_at?: string | null; total_amount?: number | string | null }>(
      "pharmacy_pos_sales",
      "created_at, total_amount",
      { orderBy: "created_at", limit: 500 }
    ),
    loadSubscriptionData(),
    safeRows<AuditRow>(
      "audit_log",
      "id, action, table_name, record_id, user_id, user_role, tenant_id, created_at, new_value",
      { orderBy: "created_at", limit: 20 }
    ),
    safeRows<ApplicationRow>(
      "hospital_leads",
      "id, hospital_name, facility_type, contact_name, contact_email, location, status, created_at",
      { orderBy: "created_at", limit: 8 }
    ),
    safeRows<LeadRow>(
      "professional_leads",
      "id, full_name, email, hospital_name, role, location, status, created_at",
      { orderBy: "created_at", limit: 8 }
    ),
    safeRows<OnboardingRow>("pharmacy_onboarding", "tenant_id, current_step", { limit: 500 }),
    safeRows<TicketRow>("support_tickets", "id, subject, status, created_at", {
      filters: [["status", "open"]],
      orderBy: "created_at",
      limit: 5,
    }),
  ]);

  const mrr = subData.mrr;
  const activeSubCount = subData.counts.active ?? 0;
  const pastDueCount = subData.counts.past_due ?? 0;
  const suspendedCount = (subData.counts.suspended ?? 0) + (subData.counts.cancelled ?? 0) + (subData.counts.canceled ?? 0);
  const trialCount = (subData.counts.trial ?? 0) + (subData.counts.trialing ?? 0);
  const since = new Date(fourteenDaysAgo).getTime();
  const recentTenantRows = recentTenants.filter((row) => row.created_at && new Date(row.created_at).getTime() >= since);
  const recentProfileRows = recentProfiles.filter((row) => row.created_at && new Date(row.created_at).getTime() >= since);
  const facilitySparkline = dailyCountsFromRows(recentTenantRows);
  const userSparkline = dailyCountsFromRows(recentProfileRows);
  const salesSparkline = dailyCountsFromRows(transactionRows);
  const salesPeriod = transactionRows.length;
  const salesRecentRows = transactionRows.filter(
    (row) => row.created_at && new Date(row.created_at) >= new Date(fourteenDaysAgo)
  );
  const salesRecent = salesRecentRows.length;
  const salesRecentUGX = salesRecentRows.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);

  const facilityDelta = percentDelta(sumWindow(facilitySparkline, 7, 14), sumWindow(facilitySparkline, 0, 7));
  const userDelta = percentDelta(sumWindow(userSparkline, 7, 14), sumWindow(userSparkline, 0, 7));
  const salesDelta = percentDelta(sumWindow(salesSparkline, 7, 14), sumWindow(salesSparkline, 0, 7));

  const onboardingInProgress = onboardingRows.filter((row) => {
    const step = row.current_step ?? 0;
    return step > 0 && step < 5;
  }).length;

  const activityFromAudit = auditRows.map((row) => ({
    id: row.id ?? crypto.randomUUID(),
    kind: "audit" as const,
    title: row.action ?? "System event",
    subtitle: row.table_name ?? "platform",
    href: "/platform/audit-log",
    createdAt: formatDateTime(row.created_at),
  }));

  const activityFromApplications = applications.slice(0, 4).map((row) => ({
    id: `app-${row.id}`,
    kind: "application" as const,
    title: `New ${row.facility_type === "pharmacy" ? "pharmacy" : "hospital"} application from ${row.hospital_name ?? row.contact_name ?? "Unknown facility"}`,
    subtitle: `${row.location ?? "Unknown district"} · ${row.status ?? "new"}`,
    href: "/platform/applications",
    createdAt: formatDateTime(row.created_at),
  }));

  const activityFromLeads = professionalLeads.slice(0, 3).map((row) => ({
    id: `lead-${row.id}`,
    kind: "lead" as const,
    title: `Professional lead: ${row.full_name}`,
    subtitle: `${row.role} · ${row.location ?? "Unknown"}`,
    href: "/platform/applications",
    createdAt: formatDateTime(row.created_at),
  }));

  const activity = [...activityFromApplications, ...activityFromLeads, ...activityFromAudit]
    .slice(0, 12);

  const attentionItems = [
    pastDueCount > 0
      ? {
          id: "past_due",
          label: "Past-due subscriptions",
          count: pastDueCount,
          href: "/platform/billing",
          detail: "Within grace — collect payment before suspension",
          actionLabel: "Collect",
        }
      : null,
    suspendedCount > 0
      ? {
          id: "suspended",
          label: "Suspended subscriptions",
          count: suspendedCount,
          href: "/platform/billing",
          detail: "Tenants locked out — reactivate after payment",
          actionLabel: "Review billing",
        }
      : null,
    pendingApplications > 0
      ? {
          id: "applications",
          label: "Pending applications",
          count: pendingApplications,
          href: "/platform/applications",
          detail: "Review and qualify new facility interest",
          actionLabel: "Review apps",
        }
      : null,
    pendingKyc > 0
      ? {
          id: "kyc",
          label: "Unverified professionals",
          count: pendingKyc,
          href: "/platform/approvals",
          detail: "Documents awaiting review",
          actionLabel: "Review KYC",
        }
      : null,
    openTickets > 0
      ? {
          id: "tickets",
          label: "Open support tickets",
          count: openTickets,
          href: "/platform/support",
          detail: "Customer issues need response",
          actionLabel: "Open tickets",
        }
      : null,
    onboardingInProgress > 0
      ? {
          id: "onboarding",
          label: "Pharmacies onboarding",
          count: onboardingInProgress,
          href: "/platform/pharmacy-network",
          detail: "Tenants mid-setup — nudge to complete",
          actionLabel: "Nudge setup",
        }
      : null,
  ].filter(Boolean) as OverviewCommandCenterData["attentionItems"];

  const attentionTotal = attentionItems.reduce((sum, item) => sum + item.count, 0);

  const topApplications = applications
    .filter((row) => (row.status ?? "new") === "new")
    .slice(0, 3)
    .map((row) => ({
      id: row.id ?? "",
      name: row.hospital_name ?? row.contact_name ?? "Unnamed",
      email: row.contact_email ?? "",
      district: row.location ?? "—",
    }));

  const prodDeploy = productionTruth.vercelDeployments.deployments[0];

  const rc1Pulse = getHospitalPilotRc1Pulse();

  const productionTruthCards: ProductionTruthCard[] = [
    {
      label: "GitHub main",
      value: productionTruth.githubMain.shortSha ?? productionTruth.githubMain.status,
      status: truthCardStatus("github", productionTruth.githubMain.status),
      href: "/platform/deployments",
      detail: productionTruth.githubMain.detail,
    },
    {
      label: "Synapse OS Production",
      value: prodDeploy?.shortSha ?? productionTruth.vercelDeployments.status,
      status: truthCardStatus("sha", productionTruth.releaseAlignment.githubVsVercel.status),
      href: "/platform/deployments",
      detail: `${productionTruth.releaseAlignment.githubVsVercel.status} · ${productionTruth.vercelDeployments.detail}`,
    },
    {
      label: "Release alignment",
      value: productionTruth.releaseAlignment.status,
      status: truthCardStatus("sha", productionTruth.releaseAlignment.status === "ALIGNED" ? "MATCH" : productionTruth.releaseAlignment.status === "DRIFT" ? "BEHIND" : "UNKNOWN"),
      href: "/platform/deployments",
      detail: productionTruth.releaseAlignment.detail,
    },
    {
      label: "Hospital Pilot RC1",
      value: `${rc1Pulse.status} · ${rc1Pulse.passed}/${rc1Pulse.total} (live ${rc1Pulse.livePassed}/${rc1Pulse.liveTotal})`,
      status: rc1Pulse.status === "PILOT_READY" ? "green" : rc1Pulse.status === "STRONG_YELLOW" ? "amber" : "slate",
      href: "/platform/deployments",
      detail: rc1Pulse.detail,
    },
    {
      label: "Admin process",
      value: productionTruth.processDeploy.shortSha ?? "NO SHA",
      status: productionTruth.processDeploy.sha ? "amber" : "slate",
      href: "/platform/deployments",
      detail: productionTruth.processDeploy.detail,
    },
    {
      label: "Remote migration",
      value: productionTruth.remoteMigration.version ?? productionTruth.remoteMigration.status,
      status: truthCardStatus("sha", productionTruth.releaseAlignment.repoVsRemoteMigration.status),
      href: "/platform/deployments",
      detail: productionTruth.remoteMigration.detail,
    },
    {
      label: "Database",
      value: `${productionTruth.database.status} · ${productionTruth.database.latencyMs}ms`,
      status: truthCardStatus("db", productionTruth.database.status),
      href: "/platform/health",
      detail: productionTruth.database.detail,
    },
    {
      label: "OpenRouter",
      value: productionTruth.openRouter.status,
      status: truthCardStatus("openrouter", productionTruth.openRouter.status),
      href: "/platform/intelligence",
      detail: productionTruth.openRouter.detail,
    },
    {
      label: "WHO ICD-11",
      value: productionTruth.icd11.status,
      status: truthCardStatus("icd11", productionTruth.icd11.status),
      href: "/platform/icd11",
      detail: productionTruth.icd11.detail,
    },
    ...productionTruth.modules.map((mod) => ({
      label: mod.label,
      value: mod.status,
      status: "slate" as const,
      href: mod.href,
    })),
  ];

  return {
    metrics: [
      {
        label: "Active facilities",
        value: activeFacilities.toLocaleString(),
        href: "/platform/hospitals",
        sparkline: facilitySparkline,
        delta: facilityDelta,
        deltaLabel: "vs prior 7 days",
      },
      {
        label: "Total users",
        value: totalUsers.toLocaleString(),
        href: "/platform/users",
        sparkline: userSparkline,
        delta: userDelta,
        deltaLabel: "vs prior 7 days",
      },
      {
        label: "MRR (UGX)",
        value: formatUGX(mrr),
        href: "/platform/billing",
        sparkline: Array.from({ length: 14 }, (_, i) => Math.round((mrr / 14) * (i + 1))),
        delta: null,
        deltaLabel: `${activeSubCount} active · ${trialCount} trial`,
      },
      {
        label: "POS sales",
        value: salesPeriod.toLocaleString(),
        href: "/platform/analytics",
        sparkline: salesSparkline,
        delta: salesDelta,
        deltaLabel: `${salesRecent} in last 14 days · ${formatUGX(salesRecentUGX)}`,
      },
      {
        label: "Active sessions",
        value: liveSessions.toLocaleString(),
        href: "/platform/security",
        sparkline: Array.from({ length: 14 }, () => liveSessions),
        delta: null,
        deltaLabel: "Live synapse_sessions",
      },
    ],
    health: [
      {
        label: "Database",
        value: dbHealth.ok ? `OPERATIONAL · ${dbHealth.latencyMs}ms` : "OUTAGE",
        status: dbHealth.ok ? (dbHealth.latencyMs < 500 ? "green" : "amber") : "red",
        href: "/platform/health",
      },
      {
        label: "OpenRouter",
        value: productionTruth.openRouter.detail,
        status: productionTruth.openRouter.status === "HEALTHY" ? "green" : productionTruth.openRouter.status === "NOT_CONFIGURED" ? "red" : "amber",
        href: "/platform/intelligence",
      },
      {
        label: "ICD-11",
        value: productionTruth.icd11.detail,
        status: productionTruth.icd11.status === "HEALTHY" ? "green" : productionTruth.icd11.status === "NOT_CONFIGURED" ? "red" : "amber",
        href: "/platform/icd11",
      },
      {
        label: "Deploy drift",
        value: productionTruth.shaComparison.detail,
        status: productionTruth.shaComparison.status === "MATCH" ? "green" : productionTruth.shaComparison.status === "BEHIND" ? "amber" : "amber",
        href: "/platform/deployments",
      },
      {
        label: "Test Center",
        value: "Run golden journeys",
        status: "amber",
        href: "/platform/test-center",
      },
    ],
    productionTruth: productionTruthCards,
    activity,
    attentionItems,
    attentionTotal,
    topApplications,
    openTickets: openTicketRows.map((row) => ({
      id: row.id ?? "",
      subject: row.subject ?? "Support ticket",
      createdAt: formatDateTime(row.created_at),
    })),
    subscriptions: {
      mrr: formatUGX(mrr),
      trialing: trialCount,
      active: activeSubCount,
      pastDue: pastDueCount,
      suspended: suspendedCount,
    },
    ecosystemSummary: {
      pharmacyTenants: tenants.filter((t) => t.facility_type === "pharmacy" && t.status !== "deleted").length,
      hospitalTenants: tenants.filter((t) => t.facility_type !== "pharmacy" && t.status !== "deleted").length,
      districts: new Set(tenants.map((t) => t.district).filter(Boolean)).size,
    },
    quickActions: [
      { label: "Run sepsis scenario", href: "/platform/simulation", tone: "primary" },
      { label: "Issue receipt", href: "/platform/receipts/new?kind=receipt" },
      { label: "Create invoice", href: "/platform/receipts/new?kind=invoice" },
      {
        label: pendingKyc > 0 ? `Review KYC (${pendingKyc})` : "Approvals",
        href: "/platform/approvals",
        tone: pendingKyc > 0 ? "primary" : "secondary",
      },
    ],
  };
}

export default async function PlatformOverviewPage() {
  await requirePlatformPage("/platform");
  const data = await getOverviewData();
  const overall = overallPlatformHealth(0);
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#E8B84B]/25 bg-[#E8B84B]/5 p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">SYNAPSE PLATFORM</p>
            <h2 className="mt-1 text-xl font-bold text-primary-color">Overall status: {overall}</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-color">
              Manifest {PRODUCT_MANIFEST.version}. Status is engineering truth, not a marketing uptime badge.
            </p>
          </div>
          <Link href="/platform/simulation" className="rounded-xl bg-[#F97316] px-4 py-2 text-sm font-semibold text-black">
            Open Simulation Lab
          </Link>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {PRODUCT_MANIFEST.products.concat(PRODUCT_MANIFEST.platform.slice(0, 3)).map((item) => (
            <Link key={item.id} href="/platform/registry" className="rounded-xl border border-subtle bg-surface px-3 py-2">
              <p className="text-[10px] uppercase text-muted-color">{item.name}</p>
              <p className="mt-1 text-xs font-medium text-primary-color">{statusLabel(item.status)}</p>
            </Link>
          ))}
        </div>
      </section>
      <OverviewCommandCenter data={data} />
    </div>
  );
}
