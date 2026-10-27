import { NextResponse } from "next/server"
import { ImportRejected } from "@/lib/import-guard"
import { TallyTemplateError } from "./workbook"
import { TallySourceError } from "./source"

const STATUS_BY_CODE: Record<string, number> = {
  MIGRATION_EMPTY_FILE: 400,
  MIGRATION_FILE_TOO_LARGE: 413,
  MIGRATION_XML_NOT_UTF8: 415,
  MIGRATION_XML_TOO_COMPLEX: 400,
  MIGRATION_XML_ENTITIES_REJECTED: 400,
  TALLY_CONVERSION_DATE_REQUIRED: 400,
  TALLY_FILE_TYPE_UNSUPPORTED: 415,
  TALLY_FILE_MISSING: 404,
  TALLY_PLAN_MISSING: 409,
}

/** One place for the parser, template and upload guards to become HTTP. */
export function tallyErrorResponse(error: unknown): NextResponse {
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
      { error: message.replace(/^[A-Z_]+:\s*/, ""), code },
      { status },
    )
  }

  console.error("[pharmacy][tally]", error)
  return NextResponse.json({ error: "The Tally file could not be processed." }, { status: 500 })
}
