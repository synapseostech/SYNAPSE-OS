import { NextRequest, NextResponse } from "next/server"
import { requireCapability } from "@/lib/pharmacy-context"
import { sessionHasCapability } from "@/lib/capabilities"
import { httpStatusForPharmacyError } from "@synapse/db/errors"
import { closeTill } from "@/lib/pos/till-service"

export async function POST(request: NextRequest) {
  const auth = await requireCapability(["shift.open_close", "shift.approve_variance"])
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => null)
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : ""
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 })

  const countedCash = Number(body?.countedCash)
  const varianceReason = typeof body?.varianceReason === "string" ? body.varianceReason : null
  // Closing another cashier's till is a supervisor action.
  const requestedCashier = typeof body?.cashierId === "string" ? body.cashierId : auth.session.userId
  if (requestedCashier !== auth.session.userId && !sessionHasCapability(auth.session, "shift.approve_variance")) {
    return NextResponse.json({ error: "Only a supervisor can close another cashier's till." }, { status: 403 })
  }
  const result = await closeTill({
    tenantId: auth.tenantId,
    cashierId: requestedCashier,
    sessionId,
    countedCash,
    varianceReason,
    notes: typeof body?.notes === "string" ? body.notes : null,
    closerId: auth.session.userId,
  })
  if (!result.ok) {
    // A cashier may close with a variance reason; a supervisor reviews it later.
    // That is a deliberate policy, not a missing check, so there is no extra gate
    // here — the reason is required by closeTill and recorded with the session.
    return NextResponse.json(result.error, { status: httpStatusForPharmacyError(result.error.code) })
  }
  return NextResponse.json({ ok: true, session: result.session })
}
