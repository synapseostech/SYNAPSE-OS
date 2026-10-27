import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "../../../../lib/supabase/server";
import { parseCsv, toRecord, CsvError } from "../../../../lib/import/csv";
import { dedupeKeyFor } from "../../../../lib/import/map-row";
import {
  isImportContextError,
  isUuid,
  loadOwnedBatch,
  notFoundBatch,
  requireImportContext,
} from "../../../../lib/import/guard";

/** 5 MB is generous for a patient master list and keeps parsing bounded. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const INSERT_CHUNK = 500;
const ALLOWED_EXTENSIONS = [".csv", ".txt"];

export async function POST(req: NextRequest) {
  const gate = await requireImportContext();
  if (isImportContextError(gate)) return gate;
  const ctx = gate;

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });

  const batchId = String(form.get("batchId") ?? "");
  const file = form.get("file");

  if (!isUuid(batchId) || !(file instanceof File)) {
    return NextResponse.json({ error: "batchId and file required" }, { status: 400 });
  }

  const batch = await loadOwnedBatch(batchId, ctx.tenantId);
  if (!batch) return notFoundBatch();

  if (batch.status === "importing") {
    return NextResponse.json({ error: "Batch is executing" }, { status: 409 });
  }

  const lowerName = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return NextResponse.json(
      { error: "Only .csv or .txt files are accepted", code: "UNSUPPORTED_FILE_TYPE" },
      { status: 415 },
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "File exceeds the 5 MB import limit", code: "FILE_TOO_LARGE" },
      { status: 413 },
    );
  }

  let parsed;
  try {
    parsed = parseCsv(await file.text());
  } catch (err) {
    const message = err instanceof CsvError ? err.message : "File could not be parsed";
    return NextResponse.json({ error: message, code: "PARSE_ERROR" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const sb = supabase as any;

  // Re-uploading a corrected file replaces the rows that never became patients.
  // Rows already imported are left untouched so nothing is silently rewritten.
  const { error: clearError } = await sb
    .from("import_batch_rows")
    .delete()
    .eq("batch_id", batchId)
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["pending", "error"]);

  if (clearError) {
    console.error("[import/upload] clear failed", { code: clearError.code });
    return NextResponse.json({ error: "Could not stage import rows" }, { status: 500 });
  }

  const seen = new Set<string>();
  const rows = parsed.rows
    .map((row) => {
      const record = toRecord(parsed.header, row.values);
      return {
        batch_id: batchId,
        tenant_id: ctx.tenantId,
        created_by: ctx.userId,
        row_number: row.line,
        entity: "patient",
        source_record: record,
        dedupe_key: dedupeKeyFor(record),
        status: "pending",
      };
    })
    .filter((row) => {
      if (seen.has(row.dedupe_key)) return false;
      seen.add(row.dedupe_key);
      return true;
    });

  const malformedRows = parsed.malformed.map((row) => ({
    batch_id: batchId,
    tenant_id: ctx.tenantId,
    created_by: ctx.userId,
    row_number: row.line,
    entity: "patient",
    source_record: { raw: row.values.join(",") },
    dedupe_key: null,
    status: "error",
    validation_errors: {
      message: `Row has ${row.values.length} fields but the header has ${parsed.header.length}`,
    },
  }));

  const allRows = [...rows, ...malformedRows];

  for (let i = 0; i < allRows.length; i += INSERT_CHUNK) {
    const chunk = allRows.slice(i, i + INSERT_CHUNK);
    const { error } = await sb.from("import_batch_rows").insert(chunk);
    if (error) {
      console.error("[import/upload] insert failed", { code: error.code });
      return NextResponse.json({ error: "Could not stage import rows" }, { status: 500 });
    }
  }

  // Counts describe the batch, not the file just uploaded: a re-upload keeps
  // the rows an earlier run already imported, so a file-only count would
  // report fewer rows than the batch holds.
  const counts = await Promise.all(
    ["imported", "error", "pending"].map(async (status) => {
      const { count } = await sb
        .from("import_batch_rows")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", batchId)
        .eq("tenant_id", ctx.tenantId)
        .eq("status", status);
      return [status, count ?? 0] as const;
    }),
  );
  const byStatus = Object.fromEntries(counts) as Record<string, number>;
  const importedRows = byStatus.imported ?? 0;
  const errorRows = byStatus.error ?? 0;
  const pendingRows = byStatus.pending ?? 0;

  const { error: batchError } = await sb
    .from("import_batches")
    .update({
      total_rows: importedRows + errorRows + pendingRows,
      valid_rows: importedRows,
      error_rows: errorRows,
      status: "uploaded",
    })
    .eq("id", batchId)
    .eq("tenant_id", ctx.tenantId);

  if (batchError) {
    console.error("[import/upload] batch update failed", { code: batchError.code });
    return NextResponse.json({ error: "Could not update import batch" }, { status: 500 });
  }

  return NextResponse.json({
    totalRows: allRows.length,
    stagedRows: rows.length,
    malformedRows: malformedRows.length,
    duplicateRowsSkipped: parsed.rows.length - rows.length,
    previewRows: rows.slice(0, 10).map((r) => r.source_record),
  });
}
