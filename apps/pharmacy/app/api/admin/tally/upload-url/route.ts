import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission } from "@/lib/tally/auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  createTallyUploadTarget,
  TALLY_SOURCE_LIMIT,
  type TallySourceExtension,
} from "@/lib/tally/storage"

const db = () => supabaseAdmin as any

const EXTENSIONS: Record<string, TallySourceExtension> = {
  xml: "xml",
  xlsx: "xlsx",
  csv: "csv",
}

/**
 * POST /api/admin/tally/upload-url
 * Creates the import session and a signed URL the browser uploads to directly.
 * No file bytes pass through the request body.
 */
export async function POST(request: NextRequest) {
  const auth = await requireTallyPermission(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { actorId, tenantId } = auth

  let body: { fileName?: string; fileSize?: number }
  try {
    body = (await request.json()) as { fileName?: string; fileSize?: number }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const fileName = String(body.fileName ?? "").trim()
  const extension = EXTENSIONS[fileName.toLowerCase().split(".").pop() ?? ""]
  if (!extension) {
    return NextResponse.json(
      { error: "Choose a Tally XML export, an .xlsx workbook, or a .csv template file." },
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
    const target = await createTallyUploadTarget({ storage: db().storage }, {
      tenantId,
      sessionId,
      extension,
    })

    const { error: attachError } = await db()
      .from("pharmacy_import_sessions")
      .update({
        file_url: target.path,
        ai_mapping: { format: extension, path: target.path, bucket: target.bucket },
      })
      .eq("id", sessionId)
      .eq("tenant_id", tenantId)

    // Without the stored path the upload lands somewhere preview cannot find,
    // so fail honestly instead of handing back an unusable target.
    if (attachError) throw new Error(attachError.message)

    return NextResponse.json({ sessionId, ...target })
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
