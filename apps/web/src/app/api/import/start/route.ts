import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "../../../../lib/supabase/server";
import { checkRateLimit, rateLimiters } from "../../../../lib/rate-limit";
import {
  isImportContextError,
  requireImportContext,
} from "../../../../lib/import/guard";

const MAX_NAME_LENGTH = 200;

export async function POST(req: NextRequest) {
  const gate = await requireImportContext();
  if (isImportContextError(gate)) return gate;
  const ctx = gate;

  // Rate limit on the authenticated principal, not on a spoofable header.
  const { success } = await checkRateLimit(rateLimiters.import, `import-start:${ctx.userId}`);
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const body = (await req.json().catch(() => null)) as {
    hospitalId?: string;
    sourceType?: string;
    sourceName?: string;
    importScope?: string;
  } | null;

  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const sourceType = typeof body.sourceType === "string" ? body.sourceType.trim() : "";
  const sourceName = typeof body.sourceName === "string" ? body.sourceName.trim() : "";
  const importScope = typeof body.importScope === "string" ? body.importScope.trim() : "";

  if (!sourceType || !sourceName || !importScope) {
    return NextResponse.json(
      { error: "sourceType, sourceName and importScope are required" },
      { status: 400 },
    );
  }
  if (sourceName.length > MAX_NAME_LENGTH || sourceType.length > 64 || importScope.length > 64) {
    return NextResponse.json({ error: "Field exceeds maximum length" }, { status: 400 });
  }

  // A client-supplied hospital must match the caller's own facility. It is
  // never used to choose the target tenant.
  if (body.hospitalId != null && body.hospitalId !== "" && body.hospitalId !== ctx.hospitalId) {
    return NextResponse.json(
      { error: "hospitalId does not match the authenticated facility" },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();
  const { data, error } = await (supabase as any)
    .from("import_batches")
    .insert({
      hospital_id: ctx.hospitalId,
      tenant_id: ctx.tenantId,
      created_by: ctx.userId,
      source_type: sourceType,
      source_name: sourceName,
      import_scope: importScope,
      // One of the values import_batches_status_check allows.
      status: "draft",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[import/start] insert failed", { code: error.code });
    return NextResponse.json({ error: "Could not create import batch" }, { status: 500 });
  }

  return NextResponse.json({ batchId: data.id });
}
