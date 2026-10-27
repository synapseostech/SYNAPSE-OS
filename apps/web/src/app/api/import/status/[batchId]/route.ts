import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "../../../../../lib/supabase/server";
import {
  isImportContextError,
  isUuid,
  loadOwnedBatch,
  notFoundBatch,
  requireImportContext,
} from "../../../../../lib/import/guard";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const gate = await requireImportContext();
  if (isImportContextError(gate)) return gate;
  const ctx = gate;

  const { batchId } = await params;
  if (!isUuid(batchId)) return notFoundBatch();

  const batch = await loadOwnedBatch(batchId, ctx.tenantId);
  if (!batch) return notFoundBatch();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceClient() as any;
  const { data, error } = await db
    .from("import_batches")
    .select("status, total_rows, valid_rows, error_rows, summary")
    .eq("id", batchId)
    .eq("tenant_id", ctx.tenantId)
    .single();

  if (error || !data) return notFoundBatch();

  const total = (data.total_rows as number) || 0;
  const done = ((data.valid_rows as number) || 0) + ((data.error_rows as number) || 0);

  return NextResponse.json({
    status: data.status,
    totalRows: total,
    validRows: data.valid_rows ?? 0,
    errorRows: data.error_rows ?? 0,
    progressPercent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    summary: data.summary ?? null,
  });
}
