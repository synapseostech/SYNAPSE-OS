import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { TALLY_CONTINUATION_UNKNOWN } from "@/lib/tally/continuation"
import {
  CUTOVER_ALREADY_COMPLETE,
  findCompletedCutover,
  findCutoverBlockingSession,
  findTallyCutoverOwner,
} from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  createTallyStagedUploadTarget,
  TALLY_SOURCE_LIMIT,
  type TallySourceExtension,
} from "@/lib/tally/storage"

const db = () => supabaseAdmin as any

const EXTENSIONS: Record<string, TallySourceExtension> = {
  xml: "xml",
  xlsx: "xlsx",
  xls: "xls",
  csv: "csv",
  zip: "zip",
}

/**
 * POST /api/admin/tally/upload-url
 * Creates the import session and a signed URL the browser uploads to directly.
 * No file bytes pass through the request body.
 *
 * `source: "bridge"` creates the session without a signed URL: the live
 * extraction uploads each chunk to its own target, obtained from the extract
 * route, so there is no single file for this session to point at.
 *
 * `continuationOf` names the session whose clean close this import extends.
 * The body is read before the one-shot guard because that guard is the whole
 * question: without a continuation the pharmacy is cut over and this is
 * refused, with one the session is created and the company, period and mode
 * are checked when the plan is built.
 */
export async function POST(request: NextRequest) {
  const auth = await requireTallyAdmin(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { actorId, tenantId } = auth

  let body: {
    fileName?: string
    fileSize?: number
    source?: unknown
    sessionId?: unknown
    continuationOf?: unknown
  }
  try {
    body = (await request.json()) as {
      fileName?: string
      fileSize?: number
      source?: unknown
      sessionId?: unknown
      continuationOf?: unknown
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (body.source !== undefined && body.source !== "file" && body.source !== "bridge") {
    return NextResponse.json(
      { error: "source must be either \"file\" or \"bridge\"" },
      { status: 400 },
    )
  }

  const continuationOf =
    typeof body.continuationOf === "string" ? body.continuationOf.trim() : ""
  const requestedSession = typeof body.sessionId === "string" ? body.sessionId.trim() : ""

  const cutover = await findCompletedCutover(tenantId)
  if (cutover) {
    // Joining an existing session asks that session's own record; creating one
    // asks the caller, who must name the session that closed the cut-over.
    const allowed = requestedSession
      ? (await findCutoverBlockingSession(tenantId, requestedSession)) === null
      : continuationOf === cutover.sessionId
    if (!allowed) {
      return NextResponse.json(
        continuationOf ? TALLY_CONTINUATION_UNKNOWN : CUTOVER_ALREADY_COMPLETE,
        { status: 409 },
      )
    }
  } else if (continuationOf) {
    return NextResponse.json(TALLY_CONTINUATION_UNKNOWN, { status: 409 })
  } else {
    const cutoverOwner = await findTallyCutoverOwner(tenantId)
    if (cutoverOwner) {
      return NextResponse.json(
        {
          error: "A Tally cut-over has already started for this pharmacy. Resume its existing session.",
          code: "TALLY_CUTOVER_IN_PROGRESS",
          sessionId: cutoverOwner,
        },
        { status: 409 },
      )
    }
  }

  if (body.source === "bridge") {
    const { data: created, error } = await db()
      .from("pharmacy_import_sessions")
      .insert({
        tenant_id: tenantId,
        source_system: "Tally",
        file_name: "Tally live extraction",
        status: "pending",
        created_by: actorId,
        ai_mapping: {
          format: "xml",
          source: "bridge",
          path: null,
          ...(continuationOf ? { continuationOf } : {}),
        },
      })
      .select("id")
      .single()
    if (error || !created) {
      return NextResponse.json(
        { error: error?.message ?? "Could not start the import session." },
        { status: 500 },
      )
    }
    return NextResponse.json({ sessionId: (created as { id: string }).id })
  }

  const fileName = String(body.fileName ?? "").trim()
  const extension = EXTENSIONS[fileName.toLowerCase().split(".").pop() ?? ""]
  if (!extension) {
    return NextResponse.json(
      {
        error:
          "Choose a Tally XML export, a zipped export package, an .xlsx/.xls workbook, or a .csv template file.",
      },
      { status: 415 },
    )
  }
  if (body.fileSize !== undefined && (body.fileSize <= 0 || body.fileSize > TALLY_SOURCE_LIMIT)) {
    return NextResponse.json(
      { error: `File must be between 1 byte and ${TALLY_SOURCE_LIMIT / 1024 / 1024} MB.` },
      { status: 413 },
    )
  }

  // The parser rejects a name carrying control characters; drop them at the door.
  const safeName =
    fileName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) ||
    `tally-export.${extension}`

  // Every file lands on a staging path of its own: a file's chunk id depends on
  // what it says about its company and period, which only parsing can reveal.
  const uploadId = randomUUID()
  const stagedTarget = (sessionId: string) =>
    createTallyStagedUploadTarget(
      { storage: db().storage },
      { tenantId, sessionId, uploadId, extension },
    )

  // A later file joins the session the first one created. Nothing is inserted:
  // the extra uploads are adopted by the sources route once parsed.
  if (requestedSession) {
    const { data: session, error: sessionError } = await db()
      .from("pharmacy_import_sessions")
      .select("id, status")
      .eq("id", requestedSession)
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (sessionError || !session) {
      return NextResponse.json({ error: "Import session not found" }, { status: 404 })
    }
    if (session.status === "importing" || session.status === "complete") {
      return NextResponse.json(
        { error: "This import has already been applied and cannot take more files." },
        { status: 409 },
      )
    }
    try {
      const target = await stagedTarget(requestedSession)
      return NextResponse.json({ sessionId: requestedSession, uploadId, ...target })
    } catch (uploadError) {
      const message =
        uploadError instanceof Error ? uploadError.message : "Upload could not be prepared."
      return NextResponse.json({ error: message, sessionId: requestedSession }, { status: 500 })
    }
  }

  const { data: created, error } = await db()
    .from("pharmacy_import_sessions")
    .insert({
      tenant_id: tenantId,
      source_system: "Tally",
      file_name: safeName,
      status: "pending",
      created_by: actorId,
    })
    .select("id")
    .single()

  if (error || !created) {
    return NextResponse.json(
      { error: error?.message ?? "Could not start the import session." },
      { status: 500 },
    )
  }

  const sessionId = (created as { id: string }).id

  try {
    const target = await stagedTarget(sessionId)

    const { error: attachError } = await db()
      .from("pharmacy_import_sessions")
      .update({
        file_url: target.path,
        ai_mapping: {
          format: extension,
          path: target.path,
          bucket: target.bucket,
          ...(continuationOf ? { continuationOf } : {}),
        },
      })
      .eq("id", sessionId)
      .eq("tenant_id", tenantId)

    // Without the stored path the upload lands somewhere preview cannot find,
    // so fail honestly instead of handing back an unusable target.
    if (attachError) throw new Error(attachError.message)

    return NextResponse.json({ sessionId, uploadId, ...target })
  } catch (uploadError) {
    const message = uploadError instanceof Error ? uploadError.message : "Upload could not be prepared."
    await db()
      .from("pharmacy_import_sessions")
      .update({ status: "failed", error_message: message.slice(0, 500) })
      .eq("id", sessionId)
      .eq("tenant_id", tenantId)
    return NextResponse.json({ error: message, sessionId }, { status: 500 })
  }
}
