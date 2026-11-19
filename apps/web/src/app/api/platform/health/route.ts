import { NextResponse } from "next/server";
import { createServiceClient } from "../../../../lib/supabase/server";
import { requirePlatformAdminApi } from "../../../../lib/platform/auth";
import { getProductionTruth } from "../../../../lib/platform/production-truth";

export const dynamic = "force-dynamic";

type ProbeStatus =
  | "OPERATIONAL"
  | "DEGRADED"
  | "OUTAGE"
  | "CONFIGURED"
  | "NOT_CONFIGURED"
  | "NO_TELEMETRY"
  | "HEALTHY"
  | "FAILED";

function probe(status: ProbeStatus, detail: string, extra: Record<string, unknown> = {}) {
  return { status, detail, ...extra };
}

export async function GET() {
  const auth = await requirePlatformAdminApi("system_health.read");
  if (!auth.ok) return auth.response;

  try {
    const supabaseAdmin = createServiceClient();
    const truth = await getProductionTruth();

    const [{ data: aiRows }, { count: conflicts }] = await Promise.all([
      (supabaseAdmin as any)
        .from("ai_call_logs")
        .select("latency_ms, success, created_at")
        .order("created_at", { ascending: false })
        .limit(50),
      (supabaseAdmin as any)
        .from("sync_conflicts")
        .select("id", { count: "exact", head: true })
        .eq("resolved", false),
    ]);

    const aiSample = aiRows ?? [];
    const aiSuccessRate = aiSample.length
      ? Math.round((aiSample.filter((row: { success?: boolean }) => row.success).length / aiSample.length) * 100)
      : null;

    const prodDeploy = truth.vercelDeployments.deployments[0];

    return NextResponse.json({
      checkedAt: truth.checkedAt,
      productionTruth: {
        githubMain: {
          status: truth.githubMain.status,
          shortSha: truth.githubMain.shortSha,
          detail: truth.githubMain.detail,
        },
        processDeploy: truth.processDeploy,
        shaComparison: truth.shaComparison,
        releaseAlignment: truth.releaseAlignment,
        repoMigration: truth.repoMigration,
        remoteMigration: truth.remoteMigration,
        synapseProduction: prodDeploy
          ? {
              status: truth.vercelDeployments.status,
              shortSha: prodDeploy.shortSha,
              match: truth.releaseAlignment.githubVsVercel.status,
              detail: truth.vercelDeployments.detail,
            }
          : {
              status: truth.vercelDeployments.status,
              shortSha: null,
              match: truth.releaseAlignment.githubVsVercel.status,
              detail: truth.vercelDeployments.detail,
            },
        database: truth.database,
        openRouter: truth.openRouter,
        icd11: truth.icd11,
        modules: truth.modules,
      },
      database: probe(truth.database.status, truth.database.detail, {
        latencyMs: truth.database.latencyMs,
      }),
      supabase: {
        connectivity: probe(
          truth.database.status,
          truth.database.status === "OUTAGE" ? "Tenant probe failed" : "Tenant probe succeeded"
        ),
        dbSize: probe("NO_TELEMETRY", "Size metrics not wired to provider API"),
        activeConnections: probe("NO_TELEMETRY", "Connection count not available"),
        lastMigration: truth.remoteMigration.status === "HEALTHY"
          ? probe("CONFIGURED", truth.remoteMigration.detail, {
              version: truth.remoteMigration.version,
              name: truth.remoteMigration.name,
              repoVersion: truth.repoMigration.version,
              match: truth.releaseAlignment.repoVsRemoteMigration.status,
            })
          : truth.remoteMigration.status === "NOT_CONFIGURED"
            ? probe("NOT_CONFIGURED", truth.remoteMigration.detail)
            : probe("NO_TELEMETRY", truth.remoteMigration.detail),
        rlsCoverage: probe("NO_TELEMETRY", "Live RLS proof not available — do not treat static counts as coverage"),
      },
      vercel: truth.vercelDeployments.status === "NOT_CONFIGURED"
        ? probe("NOT_CONFIGURED", truth.vercelDeployments.detail)
        : probe(
            truth.vercelDeployments.status === "HEALTHY" ? "CONFIGURED" : "NO_TELEMETRY",
            truth.vercelDeployments.detail,
            { deployments: truth.vercelDeployments.deployments }
          ),
      github: probe(
        truth.githubMain.status === "HEALTHY"
          ? "CONFIGURED"
          : truth.githubMain.status === "NOT_CONFIGURED"
            ? "NOT_CONFIGURED"
            : truth.githubMain.status === "UNKNOWN"
              ? "NO_TELEMETRY"
              : "FAILED",
        truth.githubMain.detail,
        { shortSha: truth.githubMain.shortSha }
      ),
      openRouter: probe(
        truth.openRouter.status === "HEALTHY"
          ? "OPERATIONAL"
          : truth.openRouter.status === "NOT_CONFIGURED"
            ? "NOT_CONFIGURED"
            : "OUTAGE",
        truth.openRouter.detail,
        { latencyMs: truth.openRouter.latencyMs ?? null }
      ),
      icd11: probe(
        truth.icd11.status === "HEALTHY" || truth.icd11.status === "CONFIGURED_CACHE_ONLY"
          ? "CONFIGURED"
          : truth.icd11.status === "NOT_CONFIGURED"
            ? "NOT_CONFIGURED"
            : "DEGRADED",
        truth.icd11.detail,
        { source: truth.icd11.source, release: truth.icd11.release }
      ),
      resend: process.env.RESEND_API_KEY
        ? probe("CONFIGURED", "API key present — delivery probe not yet wired")
        : probe("NOT_CONFIGURED", "No RESEND_API_KEY"),
      ai:
        aiSample.length === 0
          ? probe("NO_TELEMETRY", "No recent ai_call_logs rows")
          : probe(
              (aiSuccessRate ?? 0) >= 90 ? "OPERATIONAL" : (aiSuccessRate ?? 0) >= 70 ? "DEGRADED" : "OUTAGE",
              `Last ${aiSample.length} calls · ${aiSuccessRate}% success · ${aiSample[0]?.latency_ms ?? "—"}ms last latency`,
              {
                lastLatencyMs: aiSample[0]?.latency_ms ?? null,
                successRate: aiSuccessRate,
                sampleSize: aiSample.length,
              }
            ),
      sync: probe(
        (conflicts ?? 0) > 0 ? "DEGRADED" : "OPERATIONAL",
        `${conflicts ?? 0} unresolved sync conflicts`,
        { unresolvedConflicts: conflicts ?? 0 }
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: "LIVE_PROBE_FAILED",
        message: error instanceof Error ? error.message : "Unknown platform health failure",
        request_id: crypto.randomUUID(),
      },
      { status: 500 }
    );
  }
}
