import { readFileSync } from "node:fs"
import path from "node:path"
import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission } from "@/lib/tally/auth"

/**
 * GET /api/admin/tally/script
 * Downloads the PowerShell script that exports Tally's books to a folder on
 * the pharmacy PC. It is the only supported way to produce the XML files this
 * page expects: the script reads Tally over its local XML/HTTP port and writes
 * `2-masters-…xml` plus dated `3-daybook-…xml` slices, which the uploader
 * places by their names.
 */

export const dynamic = "force-dynamic"

const SCRIPT_FILE = "tally-export-history.ps1"

/**
 * The traced copy keeps its path relative to the monorepo root, but the
 * process' working directory is the monorepo root in a standalone server and
 * the app directory on Vercel. Try both rather than assume one.
 */
function readScript(): Buffer | null {
  const candidates = [
    path.join(process.cwd(), "apps", "tally-bridge", "scripts", SCRIPT_FILE),
    path.join(process.cwd(), "..", "tally-bridge", "scripts", SCRIPT_FILE),
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate)
    } catch {
      continue
    }
  }
  return null
}

export async function GET(request: NextRequest) {
  const auth = await requireTallyPermission(request, "inventory.write")
  if (!auth.ok) return auth.response

  const body = readScript()
  if (!body) {
    return NextResponse.json(
      {
        error: "The export script is not available in this deployment.",
        code: "TALLY_SCRIPT_MISSING",
      },
      { status: 404 },
    )
  }

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${SCRIPT_FILE}"`,
      "Cache-Control": "no-store",
    },
  })
}
