import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "../../../../lib/supabase/server";
import { checkRateLimit, rateLimiters } from "../../../../lib/rate-limit";
import { mapPatientRow } from "../../../../lib/import/map-row";
import {
  isImportContextError,
  isUuid,
  loadOwnedBatch,
  notFoundBatch,
  requireImportContext,
} from "../../../../lib/import/guard";

/** Rows are processed in pages so one request cannot hold a transaction open indefinitely. */
const PAGE_SIZE = 200;
/** Hard ceiling per invocation. Exceeding it leaves rows staged and the batch is reported as partial. */
const MAX_ROWS_PER_RUN = 2000;
/**
 * A run that never reached its finalize step leaves the batch importing.
 * Past this lease the claim may be taken again, so a function timeout cannot
 * lock the batch out of every retry path. Longer than the platform's maximum
 * function duration, so a live run is never stolen.
 */
const RUN_LEASE_MS = 10 * 60 * 1000;

/**
 * `import_batches.status` is constrained by import_batches_status_check, which
 * has no "pending"/"running"/"partial" values. The claim moves the batch to
 * "importing"; a run that leaves work behind finishes "completed_with_errors".
 */
const CLAIMABLE_STATUSES = ["draft", "uploaded", "failed", "completed_with_errors"];
const IN_PROGRESS_STATUS = "importing";
const INCOMPLETE_STATUS = "completed_with_errors";

type BatchRow = {
  id: string;
  row_number: number;
  source_record: Record<string, string> | null;
};

function truncate(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export async function POST(req: NextRequest) {
  const gate = await requireImportContext();
  if (isImportContextError(gate)) return gate;
  const ctx = gate;

  const { success } = await checkRateLimit(rateLimiters.import, `import-execute:${ctx.userId}`);
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const body = (await req.json().catch(() => null)) as { batchId?: string } | null;
  const batchId = body?.batchId;
  if (!isUuid(batchId)) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }

  const batch = await loadOwnedBatch(batchId, ctx.tenantId);
  if (!batch) return notFoundBatch();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceClient() as any;

  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - RUN_LEASE_MS).toISOString();

  // Atomic claim. Two concurrent requests cannot both move the batch to
  // "importing": the second update re-evaluates the WHERE clause after the row
  // lock is released and matches zero rows.
  const claim = await db
    .from("import_batches")
    .update({ status: IN_PROGRESS_STATUS, started_at: now })
    .eq("id", batchId)
    .eq("tenant_id", ctx.tenantId)
    .in("status", CLAIMABLE_STATUSES)
    .select("id");

  if (claim.error) {
    console.error("[import/execute] claim failed", { code: claim.error.code });
    return NextResponse.json({ error: "Could not start import" }, { status: 500 });
  }

  // Reclaim a run that was killed before it could finalize. Imported rows stay
  // imported and only staged rows are read again, so this resumes rather
  // than repeats.
  let claimed = Boolean(claim.data && claim.data.length > 0);
  if (!claimed) {
    const retake = await db
      .from("import_batches")
      .update({ status: IN_PROGRESS_STATUS, started_at: now })
      .eq("id", batchId)
      .eq("tenant_id", ctx.tenantId)
      .eq("status", IN_PROGRESS_STATUS)
      .lt("started_at", staleBefore)
      .select("id");
    if (retake.error) {
      console.error("[import/execute] stale claim failed", { code: retake.error.code });
      return NextResponse.json({ error: "Could not start import" }, { status: 500 });
    }
    claimed = Boolean(retake.data && retake.data.length > 0);
  }

  if (!claimed) {
    return NextResponse.json(
      { error: "Batch is not ready to execute", code: "BATCH_NOT_EXECUTABLE", status: batch.status },
      { status: 409 },
    );
  }

  let processed = 0;
  let aborted = false;

  try {
    while (processed < MAX_ROWS_PER_RUN) {
      const page = await db
        .from("import_batch_rows")
        .select("id, row_number, source_record")
        .eq("batch_id", batchId)
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "staged")
        .order("row_number", { ascending: true })
        .limit(Math.min(PAGE_SIZE, MAX_ROWS_PER_RUN - processed));

      if (page.error) throw new Error(`read rows: ${page.error.code}`);
      const rows = (page.data ?? []) as BatchRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        processed += 1;
        const mapped = mapPatientRow(row.source_record ?? {});

        if (!mapped.ok) {
          await db
            .from("import_batch_rows")
            .update({ status: "rejected", validation_errors: { errors: mapped.errors } })
            .eq("id", row.id)
            .eq("tenant_id", ctx.tenantId);
          continue;
        }

        const { data: patient, error: insertError } = await db
          .from("patients")
          .insert({
            ...mapped.value,
            // Tenant and facility come from the authenticated context, never
            // from the uploaded file or the request body.
            tenant_id: ctx.tenantId,
            hospital_id: ctx.hospitalId,
          })
          .select("id")
          .single();

        if (insertError) {
          // 23505 on (hospital_id, mrn) means this patient already exists at the
          // facility. That is reported, never merged or overwritten.
          const message =
            insertError.code === "23505"
              ? "A patient with this MRN already exists at this facility"
              : truncate(insertError.message ?? "Insert failed");
          const errors = mapped.warnings.length
            ? [...mapped.warnings, message]
            : [message];
          await db
            .from("import_batch_rows")
            .update({ status: "rejected", validation_errors: { errors } })
            .eq("id", row.id)
            .eq("tenant_id", ctx.tenantId);
          continue;
        }

        await db
          .from("import_batch_rows")
          .update({
            status: "imported",
            imported_record_id: patient?.id ?? null,
            // validation_errors is NOT NULL with an '[]' default. Writing null
            // fails the whole update, which leaves the row staged and re-read
            // on the next page, so the key is omitted when there is nothing to
            // record.
            ...(mapped.warnings.length ? { validation_errors: { warnings: mapped.warnings } } : {}),
          })
          .eq("id", row.id)
          .eq("tenant_id", ctx.tenantId);
      }
    }
  } catch (err) {
    aborted = true;
    console.error("[import/execute] aborted", err instanceof Error ? err.message : err);
  }

  // Counts are read back from the database rather than tracked in memory so
  // the batch record matches what is actually stored, including rows that were
  // rejected during upload.
  const counts = await Promise.all(
    ["imported", "rejected", "staged"].map(async (status) => {
      const { count } = await db
        .from("import_batch_rows")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", batchId)
        .eq("tenant_id", ctx.tenantId)
        .eq("status", status);
      return [status, count ?? 0] as const;
    }),
  );
  const byStatus = Object.fromEntries(counts) as Record<string, number>;
  const imported = byStatus.imported ?? 0;
  const errored = byStatus.rejected ?? 0;
  const remaining = byStatus.staged ?? 0;

  const finished = !aborted && remaining === 0;
  const status = finished ? "completed" : INCOMPLETE_STATUS;

  const { error: finishError } = await db
    .from("import_batches")
    .update({
      status,
      valid_rows: imported,
      error_rows: errored,
      finished_at: finished ? new Date().toISOString() : null,
      summary: {
        imported,
        errored,
        remaining,
        processedThisRun: processed,
        aborted,
      },
    })
    .eq("id", batchId)
    .eq("tenant_id", ctx.tenantId);

  if (finishError) {
    console.error("[import/execute] finalize failed", { code: finishError.code });
    return NextResponse.json(
      { error: "Import ran but the batch record could not be updated", imported, errored, remaining },
      { status: 500 },
    );
  }

  if (!finished) {
    return NextResponse.json(
      {
        imported,
        errored,
        remaining,
        status,
        retryable: true,
        message: aborted
          ? "Import stopped early. Remaining rows can be retried."
          : "Row limit reached for this run. Execute again to continue.",
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ imported, errored, remaining, status });
}
