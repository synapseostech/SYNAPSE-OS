import { NextResponse } from "next/server";
import { requirePlatformAdminApi } from "@/lib/platform/auth";
import { listTestModules, listTestRuns } from "@/lib/platform/test-center-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePlatformAdminApi("test_center.read");
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    modules: listTestModules(),
    runs: listTestRuns(),
  });
}
