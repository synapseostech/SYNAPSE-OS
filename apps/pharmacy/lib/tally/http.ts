import { NextResponse } from "next/server"
import { ImportRejected } from "@/lib/import-guard"
import { TallyTemplateError } from "./workbook"
import { TallySourceError } from "./source"

const STATUS_BY_CODE: Record<string, number> = {
  MIGRATION_EMPTY_FILE: 400,
  MIGRATION_FILE_TOO_LARGE: 413,
  MIGRATION_XML_NOT_UTF8: 415,
  MIGRATION_XML_TOO_COMPLEX: 400,
  MIGRATION_XML_MALFORMED: 400,
  MIGRATION_XML_INCOMPLETE: 400,
  MIGRATION_XML_ENTITIES_REJECTED: 400,
  TALLY_CONVERSION_DATE_REQUIRED: 400,
  TALLY_FILE_TYPE_UNSUPPORTED: 415,
  TALLY_FILE_MISSING: 404,
  TALLY_PLAN_MISSING: 409,
}

const MESSAGE_BY_CODE: Record<string, string> = {
  MIGRATION_XML_INCOMPLETE:
    "The file ends before the export is complete, so it was cut short while downloading or copying. Export it again from Tally and upload the whole file.",
}

/**
 * The fields of a thrown value worth keeping in a log line. PostgREST reports
 * refusals as plain objects, so `instanceof Error` alone would lose the
 * SQLSTATE and the hint that name the offending row.
 */
export function describeTallyError(error: unknown): { errorMessage: string } & Record<string, unknown> {
  if (error instanceof Error) {
    const carried = error as Error & { stage?: unknown; item?: unknown; detail?: unknown }
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(typeof carried.stage === "string" ? { failedStage: carried.stage } : {}),
      ...(typeof carried.item === "string" ? { failedItem: carried.item } : {}),
      ...(carried.detail && typeof carried.detail === "object" ? { dbError: carried.detail } : {}),
      ...(error.stack ? { stack: error.stack.split("\n").slice(0, 6).join("\n") } : {}),
    }
  }
  if (typeof error === "object" && error !== null) {
    const plain: Record<string, unknown> = {}
    for (const key of ["name", "message", "code", "details", "hint"]) {
      const entry = (error as Record<string, unknown>)[key]
      if (typeof entry === "string" && entry) plain[key] = entry
    }
    const message = typeof plain.message === "string" ? plain.message : "Tally request failed"
    return { errorMessage: message, dbError: plain }
  }
  return { errorMessage: String(error) }
}

/** A greppable progress line; Vercel keeps both streams for the deployment. */
export function logTallyEvent(event: string, fields: Record<string, unknown>): void {
  console.log(`[pharmacy][tally] ${JSON.stringify({ event, ...fields })}`)
}

/** A failure line carrying everything the thrown value knew about itself. */
export function logTallyFailure(
  event: string,
  fields: Record<string, unknown>,
  error: unknown,
): void {
  console.error(`[pharmacy][tally] ${JSON.stringify({ event, ...fields, ...describeTallyError(error) })}`)
}

/** One place for the parser, template and upload guards to become HTTP. */
export function tallyErrorResponse(
  error: unknown,
  fallback = "The Tally file could not be processed.",
): NextResponse {
  if (error instanceof ImportRejected) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof TallyTemplateError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.code === "TALLY_TEMPLATE_TOO_LARGE" ? 413 : 400 },
    )
  }
  if (error instanceof TallySourceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 415 })
  }

  const message = error instanceof Error ? error.message : "Import failed"
  const code = message.match(/^([A-Z_]+):/)?.[1] ?? message
  const status = STATUS_BY_CODE[code]
  if (status) {
    return NextResponse.json(
      { error: MESSAGE_BY_CODE[code] ?? message.replace(/^[A-Z_]+:\s*/, ""), code },
      { status },
    )
  }

  logTallyFailure("tally.request.failed", {}, error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}
