import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { readTallyReplayTarget } from "@/lib/tally/plan"
import {
  evaluateReplayGate,
  replayBlockers,
  replayFindingKey,
  type SavedReplayAcknowledgement,
} from "@/lib/tally/replay-gate"
import type { TallyStorageClient } from "@/lib/tally/storage"
import type { TallyPlanSummary } from "@/lib/tally/types"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/**
 * GET /api/admin/tally/[id]/replay-report[?format=csv|json]
 * The replay's evidence as a file: what it reaches beside Tally's figures, the
 * day it runs to, and the differences the operator answered. Read-only and
 * tenant-scoped; it reports what the preview recorded, never a fresh analysis.
 */

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

type CsvColumn =
  | "record_type"
  | "key"
  | "value"
  | "label"
  | "expected"
  | "actual"
  | "difference"
  | "status"
  | "date"
  | "events"
  | "movements"
  | "kinds"
  | "code"
  | "severity"
  | "message"
  | "reason"

const CSV_COLUMNS: CsvColumn[] = [
  "record_type",
  "key",
  "value",
  "label",
  "expected",
  "actual",
  "difference",
  "status",
  "date",
  "events",
  "movements",
  "kinds",
  "code",
  "severity",
  "message",
  "reason",
]

function row(values: Partial<Record<CsvColumn, string | number | null>>): string {
  return CSV_COLUMNS.map((column) => csvCell(values[column])).join(",")
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "reports.financial")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, file_name, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (session.ai_mapping ?? {}) as Record<string, unknown>
  const summary = (mapping.summary as TallyPlanSummary | undefined) ?? null
  if (summary?.mode !== "replay") {
    return NextResponse.json(
      {
        error: "This session does not rebuild the history, so it has no replay report.",
        code: "TALLY_REPLAY_NOT_A_REPLAY",
      },
      { status: 409 },
    )
  }

  const target = await readTallyReplayTarget(storage(), tenantId, id)
  if (!target) {
    return NextResponse.json(
      {
        error: "This session's replay figures were never saved. Preview the export again.",
        code: "TALLY_REPLAY_TARGET_MISSING",
      },
      { status: 409 },
    )
  }

  const gate = evaluateReplayGate(target, mapping.replayAcknowledgement)
  const saved = mapping.replayAcknowledgement as SavedReplayAcknowledgement | undefined
  const acknowledgements =
    saved && saved.preparedAt === target.preparedAt && Array.isArray(saved.items)
      ? saved.items
      : []

  if (request.nextUrl.searchParams.get("format") === "json") {
    return NextResponse.json(
      {
        session: id,
        status: session.status,
        fileName: session.file_name,
        company: summary.company ?? summary.companyKey,
        mode: summary.mode,
        preparedAt: target.preparedAt,
        conversionDate: target.conversionDate,
        cutoffDate: target.cutoffDate,
        ordering: target.ordering,
        eventCount: target.eventCount,
        movementCount: target.movementCount,
        totals: target.totals,
        blocking: target.blocking,
        warnings: target.warnings,
        days: target.perDay,
        reconciliation: target.reconciliation,
        findings: target.findings,
        blockers: replayBlockers(target),
        gate: {
          sequenceConfirmed: gate.sequenceConfirmed,
          canApply: gate.canApply,
          missing: gate.missing.map((blocker) => blocker.key),
          unknown: gate.unknown,
          acknowledgedAt: saved?.acknowledgedAt ?? null,
          acknowledgedBy: saved?.acknowledgedBy ?? null,
          acknowledged: acknowledgements,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  }

  const lines = [CSV_COLUMNS.join(",")]

  const meta: Array<[string, string | number]> = [
    ["session", id],
    ["status", session.status],
    ["file", session.file_name ?? ""],
    ["company", summary.company ?? summary.companyKey],
    ["mode", summary.mode ?? "replay"],
    ["prepared_at", target.preparedAt],
    ["conversion_date", target.conversionDate],
    ["cutoff_date", target.cutoffDate],
    ["ordering", target.ordering],
    ["events", target.eventCount],
    ["movements", target.movementCount],
    ["rows_match", target.totals.match],
    ["rows_difference", target.totals.difference],
    ["rows_not_available", target.totals.notAvailable],
    ["sequence_confirmed", gate.sequenceConfirmed ? "yes" : "no"],
    ["can_apply", gate.canApply ? "yes" : "no"],
    ["unanswered", gate.missing.length],
    ["acknowledged_by", saved?.acknowledgedBy ?? ""],
    ["acknowledged_at", saved?.acknowledgedAt ?? ""],
  ]
  for (const [key, value] of meta) lines.push(row({ record_type: "meta", key, value }))

  for (const day of target.perDay) {
    lines.push(
      row({
        record_type: "day",
        date: day.date,
        events: day.events,
        movements: day.movements,
        kinds: Object.entries(day.kinds)
          .map(([kind, count]) => `${kind}=${count}`)
          .join(" "),
      }),
    )
  }

  for (const entry of target.reconciliation) {
    lines.push(
      row({
        record_type: "reconciliation",
        key: entry.key,
        label: entry.scope,
        expected: entry.expected,
        actual: entry.actual,
        difference: entry.difference,
        status: entry.status,
        message: entry.firstDivergence
          ? `${entry.firstDivergence.date} ${entry.firstDivergence.sourceId}${entry.firstDivergence.movementId ? ` ${entry.firstDivergence.movementId}` : ""}`
          : "",
      }),
    )
  }

  for (const [index, finding] of (target.findings ?? []).entries()) {
    lines.push(
      row({
        record_type: "finding",
        key: replayFindingKey(finding, index),
        code: finding.code,
        severity: finding.severity,
        date: finding.date,
        label: finding.stockItemName,
        expected: finding.quantityBefore,
        actual: finding.quantityAfter,
        message: finding.message,
      }),
    )
  }

  for (const item of acknowledgements) {
    lines.push(
      row({
        record_type: "acknowledgement",
        key: item.key,
        reason: item.reason,
        label: saved?.acknowledgedBy ?? "",
        date: saved?.acknowledgedAt ?? "",
      }),
    )
  }

  const slug = (summary.companyKey || "tally").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40)
  return new NextResponse(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tally-replay-${slug}-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  })
}
