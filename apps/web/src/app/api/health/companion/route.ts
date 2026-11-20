import { NextRequest, NextResponse } from "next/server"
import { redactAiLog } from "../../../../lib/ai/clinical-ai-gateway"
import { defaultCompanionDeps, resolveCompanionUser } from "../../../../lib/health-companion/session"
import { readCompanionState, sendCompanionMessage } from "../../../../lib/health-companion/service"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const NO_STORE = { "cache-control": "no-store" }

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/** Consent, quota, conversation list, and (with ?conversationId=) its messages. */
export async function GET(req: NextRequest) {
  const userId = await resolveCompanionUser(req)
  if (!userId) return json(401, { error: "Unauthorized" })
  try {
    const result = await readCompanionState(userId, defaultCompanionDeps(), req.nextUrl.searchParams.get("conversationId"))
    return json(result.status, result.body)
  } catch (error) {
    console.error("[health/companion] GET", redactAiLog({ error: error instanceof Error ? error.message : "unknown" }))
    return json(500, { error: "companion_error" })
  }
}

/** Send a message. Body: { message, conversationId?, language?: en|lg|sw, deviceContext? } */
export async function POST(req: NextRequest) {
  const userId = await resolveCompanionUser(req)
  if (!userId) return json(401, { error: "Unauthorized" })
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return json(400, { error: "invalid_json" })
  try {
    const result = await sendCompanionMessage(userId, body, defaultCompanionDeps())
    return json(result.status, result.body)
  } catch (error) {
    // Never log the message or context: metadata only.
    console.error("[health/companion] POST", redactAiLog({ error: error instanceof Error ? error.message : "unknown" }))
    return json(500, { error: "companion_error" })
  }
}

/** Delete one conversation (?conversationId=) or all of them (?all=1). */
export async function DELETE(req: NextRequest) {
  const userId = await resolveCompanionUser(req)
  if (!userId) return json(401, { error: "Unauthorized" })
  const { store } = defaultCompanionDeps()
  const params = req.nextUrl.searchParams
  try {
    if (params.get("all") === "1") {
      const deleted = await store.deleteAllConversations(userId)
      return json(200, { deleted })
    }
    const id = params.get("conversationId")
    if (!id) return json(400, { error: "conversationId_or_all_required" })
    const ok = await store.deleteConversation(userId, id)
    return ok ? json(200, { deleted: 1 }) : json(404, { error: "conversation_not_found" })
  } catch (error) {
    console.error("[health/companion] DELETE", redactAiLog({ error: error instanceof Error ? error.message : "unknown" }))
    return json(500, { error: "companion_error" })
  }
}
