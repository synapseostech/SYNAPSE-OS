import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { probeTallyExport } from "@/lib/tally/probe"

/**
 * The probe reads one hand-exported report — a per-type register or a single
 * period — not a full company export. Vercel caps a request body near 4.5 MB,
 * so the ceiling is stated here rather than discovered as a 413 from the host.
 */
const PROBE_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * POST /api/admin/tally/probe
 *
 * Answers the document-chain design's Gate 0 questions from an uploaded export:
 * which voucher types appear (Q1), which linkage tags survive the XML (Q2), and
 * the per-type counts the archive must reconcile against (Q3). Nothing is
 * written and no import session is created — the file is parsed and discarded.
 *
 * Body: the XML itself, as text.
 */
export async function POST(request: NextRequest) {
  const auth = await requireTallyAdmin(request, "inventory.write")
  if (!auth.ok) return auth.response

  const declared = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > PROBE_LIMIT_BYTES) {
    return NextResponse.json(
      {
        error: "That file is too large to probe. Upload one report or one month, not a whole company export.",
        code: "TALLY_PROBE_TOO_LARGE",
      },
      { status: 413 },
    )
  }

  const xml = await request.text()
  if (!xml.trim()) {
    return NextResponse.json(
      { error: "Send the XML export in the request body.", code: "TALLY_PROBE_EMPTY" },
      { status: 400 },
    )
  }
  if (xml.length > PROBE_LIMIT_BYTES) {
    return NextResponse.json(
      {
        error: "That file is too large to probe. Upload one report or one month, not a whole company export.",
        code: "TALLY_PROBE_TOO_LARGE",
      },
      { status: 413 },
    )
  }

  try {
    return NextResponse.json({ ok: true, report: probeTallyExport(xml) })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    // The parser refuses a file whose envelope never closed, because a partial
    // export would answer "this type is absent" for records that were cut off.
    if (message.startsWith("MIGRATION_")) {
      return NextResponse.json(
        {
          error: "That file is not a complete Tally export. Re-export it and try again.",
          code: message,
        },
        { status: 400 },
      )
    }
    console.error("[tally-probe] failed:", message)
    return NextResponse.json(
      { error: "The export could not be read.", code: "TALLY_PROBE_FAILED" },
      { status: 500 },
    )
  }
}

export const dynamic = "force-dynamic"
