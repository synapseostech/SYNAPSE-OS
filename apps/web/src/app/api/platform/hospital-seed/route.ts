import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminApi } from "@/lib/platform/auth";
import {
  seedHospital,
  resetHospital,
  reseedHospital,
  inspectHospital,
  HOSPITAL_CANONICAL_SLUG,
  HOSPITAL_CANONICAL_SEED,
} from "@synapse/db/hospital-seed";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePlatformAdminApi("test_center.read");
  if (!auth.ok) return auth.response;

  const snapshot = inspectHospital(HOSPITAL_CANONICAL_SLUG);
  if ("error" in snapshot) {
    return NextResponse.json({
      seeded: false,
      slug: HOSPITAL_CANONICAL_SLUG,
      seed: HOSPITAL_CANONICAL_SEED,
      message: "Hospital not yet seeded. POST to create.",
    });
  }

  return NextResponse.json({
    seeded: true,
    slug: snapshot.slug,
    name: snapshot.name,
    tenantId: snapshot.tenantId,
    hospitalId: snapshot.hospitalId,
    seed: snapshot.seed,
    environment: snapshot.environment,
    isSynthetic: snapshot.isSynthetic,
    departmentCount: snapshot.departments.length,
    locationCount: snapshot.locations.length,
    staffCount: snapshot.staff.length,
    patientCount: snapshot.patients.length,
    modules: snapshot.modules,
    seededAt: snapshot.seededAt,
    contact: snapshot.contact,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requirePlatformAdminApi("tenant.manage");
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const action = body.action ?? "create";

  if (action === "reset") {
    const result = resetHospital(body.slug ?? HOSPITAL_CANONICAL_SLUG);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, action: "reset", slug: result.slug });
  }

  if (action === "reseed") {
    const snapshot = reseedHospital({
      seed: body.seed ?? HOSPITAL_CANONICAL_SEED,
      slug: body.slug ?? HOSPITAL_CANONICAL_SLUG,
      actorId: auth.profile.id,
    });
    return NextResponse.json({ ok: true, action: "reseed", hospital: summarize(snapshot) });
  }

  const snapshot = seedHospital({
    seed: body.seed ?? HOSPITAL_CANONICAL_SEED,
    slug: body.slug ?? HOSPITAL_CANONICAL_SLUG,
    actorId: auth.profile.id,
  });

  return NextResponse.json({ ok: true, action: "create", hospital: summarize(snapshot) });
}

function summarize(snapshot: ReturnType<typeof seedHospital>) {
  return {
    slug: snapshot.slug,
    name: snapshot.name,
    tenantId: snapshot.tenantId,
    hospitalId: snapshot.hospitalId,
    seed: snapshot.seed,
    departmentCount: snapshot.departments.length,
    locationCount: snapshot.locations.length,
    staffCount: snapshot.staff.length,
    patientCount: snapshot.patients.length,
    seededAt: snapshot.seededAt,
  };
}
