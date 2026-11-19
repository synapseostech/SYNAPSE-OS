import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminApi } from "@/lib/platform/auth";
import {
  buildDepartmentMatrix,
  buildStaffRoleMatrix,
  runGoldenJourney,
  GOLDEN_JOURNEY_IDS,
  type GoldenJourneyId,
} from "@synapse/db/hospital-acceptance";
import { seedHospital, HOSPITAL_CANONICAL_SEED } from "@synapse/db/hospital-seed";
import { persistTestRun } from "@/lib/platform/test-center-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePlatformAdminApi("test_center.read");
  if (!auth.ok) return auth.response;

  const hospital = seedHospital({ seed: HOSPITAL_CANONICAL_SEED, actorId: auth.profile.id });
  const departments = buildDepartmentMatrix(hospital);
  const staffRoles = buildStaffRoleMatrix();

  const summary = {
    pass: departments.filter((d) => d.status === "PASS").length,
    partial: departments.filter((d) => d.status === "PARTIAL").length,
    fail: departments.filter((d) => d.status === "FAIL").length,
    notImplemented: departments.filter((d) => d.status === "NOT_IMPLEMENTED").length,
    blocked: departments.filter((d) => d.status === "BLOCKED").length,
  };

  return NextResponse.json({
    hospital: {
      slug: hospital.slug,
      name: hospital.name,
      tenantId: hospital.tenantId,
      seed: hospital.seed,
    },
    departments,
    staffRoles,
    goldenJourneys: GOLDEN_JOURNEY_IDS,
    summary,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requirePlatformAdminApi("tenant.manage");
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const journeyId = (body.journeyId ?? "MALARIA_OPD_GOLDEN") as GoldenJourneyId;
  const started = Date.now();

  const result = runGoldenJourney(journeyId, {
    seed: body.seed ?? HOSPITAL_CANONICAL_SEED,
    actorId: auth.profile.id,
  });

  const testRunId = crypto.randomUUID();
  await persistTestRun(
    {
      testRunId,
      module: `hospital-${journeyId.toLowerCase()}`,
      environment: "demo",
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      status: result.status === "PARTIAL" ? "NOT_CONFIGURED" : result.status === "NOT_IMPLEMENTED" ? "NOT_CONFIGURED" : result.status,
      error: result.steps.find((s) => s.error)?.error ?? null,
      evidence: {
        journeyId: result.journeyId,
        hospitalSlug: result.hospitalSlug,
        tenantId: result.tenantId,
        stepCount: result.steps.length,
      },
      correlationId: result.correlationId,
      startedBy: auth.profile.id,
      isSynthetic: true,
      steps: result.steps.map((s) => ({
        id: s.id,
        label: s.label,
        status: (s.status === "PARTIAL" || s.status === "NOT_IMPLEMENTED" ? "NOT_CONFIGURED" : s.status) as "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "NOT_CONFIGURED",
        durationMs: s.durationMs,
        evidence: s.evidence,
        error: s.error,
      })),
    },
    auth.profile.id,
  );

  return NextResponse.json({ run: result, testRunId });
}
