import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { requirePharmacyAdmin } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { csvRow } from "@/lib/csv"
import {
  PAGE_SIZE,
  countDataset,
  findDataset,
  readPage,
  type ExportContext,
  type ExportDataset,
} from "@/lib/export/datasets"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * A file bigger than this is refused rather than sent truncated. The cap is on
 * records read from the database, which for a flattened dataset such as
 * products is fewer than the rows written.
 */
const MAX_ROWS = 100_000

const FORMATS = new Set(["csv", "xlsx"])

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day, so 2026-02-30 is rejected rather than rolled over. */
function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

/** Today as the pharmacy reads it, so a snapshot is not stamped with yesterday. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function sheetName(dataset: ExportDataset): string {
  return dataset.label.replace(/[\\/?*[\]:]/g, " ").slice(0, 31)
}

async function recordExport(
  tenantId: string,
  profileId: string | undefined,
  dataset: ExportDataset,
  ctx: ExportContext,
  format: string,
  records: number,
): Promise<void> {
  try {
    const { error } = await (supabaseAdmin as any).from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: profileId ?? null,
      action: "EXPORT_DATA",
      entity: "EXPORT",
      entity_id: dataset.id,
      details: {
        dataset: dataset.id,
        from: dataset.dateScoped ? ctx.from : null,
        to: dataset.dateScoped ? ctx.to : null,
        format,
        records,
      },
    })
    // The export already succeeded; a failed audit write is worth a log line,
    // not a broken download.
    if (error) console.error("export: audit log insert failed", error)
  } catch (error) {
    console.error("export: audit log insert failed", error)
  }
}

function buildCsv(dataset: ExportDataset, ctx: ExportContext, totals: number[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const keys = dataset.columns.map((column) => column.key)

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // The byte-order mark is what makes Excel read the file as UTF-8
        // instead of the system code page, which mangles non-ASCII names.
        const header = csvRow(dataset.columns.map((column) => column.label))
        controller.enqueue(encoder.encode(`\uFEFF${header}\r\n`))
        let offset = 0
        for (;;) {
          const page = await readPage(dataset, ctx, totals, offset, PAGE_SIZE)
          if (page.consumed === 0) break
          offset += page.consumed
          if (page.rows.length > 0) {
            const lines = page.rows.map((row) => csvRow(keys.map((key) => row[key])))
            controller.enqueue(encoder.encode(`${lines.join("\r\n")}\r\n`))
          }
        }
        controller.close()
      } catch (error) {
        // Abort the body rather than close it, so the browser marks the
        // download failed instead of keeping a half-written file.
        controller.error(error)
      }
    },
  })
}

function buildWorkbook(
  dataset: ExportDataset,
  ctx: ExportContext,
  totals: number[],
): Promise<ArrayBuffer> {
  return (async () => {
    const keys = dataset.columns.map((column) => column.key)
    const rows: unknown[][] = [dataset.columns.map((column) => column.label)]
    let offset = 0
    for (;;) {
      const page = await readPage(dataset, ctx, totals, offset, PAGE_SIZE)
      if (page.consumed === 0) break
      offset += page.consumed
      for (const row of page.rows) rows.push(keys.map((key) => row[key] ?? ""))
    }
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName(dataset))
    return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer
  })()
}

export async function GET(request: NextRequest) {
  const auth = await requirePharmacyAdmin()
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

  const params = request.nextUrl.searchParams
  const datasetId = (params.get("dataset") ?? "").trim()
  const format = (params.get("format") ?? "csv").trim().toLowerCase()
  const from = (params.get("from") ?? "").trim()
  const to = (params.get("to") ?? "").trim()

  const dataset = findDataset(datasetId)
  if (!dataset) return bad(`Unknown export "${datasetId}".`)

  if (!FORMATS.has(format)) return bad(`Format must be csv or xlsx, not "${format}".`)

  const ctx: ExportContext = {
    db: supabaseAdmin,
    tenantId,
    from: "",
    to: "",
  }
  if (dataset.dateScoped) {
    if (!isIsoDay(from) || !isIsoDay(to)) return bad("Choose a start and end date, as YYYY-MM-DD.")
    if (to < from) return bad("The end date is before the start date.")
    ctx.from = from
    ctx.to = to
  }

  let totals: number[]
  try {
    totals = await countDataset(dataset, ctx)
  } catch (error) {
    console.error("export: counting failed", error)
    return bad("The export could not be prepared. Try again, or narrow the date range.", 500)
  }

  const records = totals.reduce((sum, count) => sum + count, 0)
  if (records > MAX_ROWS) {
    return bad(
      `That export holds ${records.toLocaleString("en-GB")} records, more than the ${MAX_ROWS.toLocaleString("en-GB")} one file may hold. Narrow the date range.`,
      413,
    )
  }

  const stamp = dataset.dateScoped ? `${ctx.from}_to_${ctx.to}` : today()
  const filename = `synapse-${dataset.id}-${stamp}.${format}`
  const disposition = `attachment; filename="${filename}"`

  await recordExport(tenantId, session.user.id, dataset, ctx, format, records)

  if (format === "csv") {
    return new NextResponse(buildCsv(dataset, ctx, totals), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": disposition,
        "Cache-Control": "no-store",
      },
    })
  }

  let buffer: ArrayBuffer
  try {
    buffer = await buildWorkbook(dataset, ctx, totals)
  } catch (error) {
    console.error("export: workbook build failed", error)
    return bad("The export could not be prepared. Try again, or narrow the date range.", 500)
  }

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  })
}
