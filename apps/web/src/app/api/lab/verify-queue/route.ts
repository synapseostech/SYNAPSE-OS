import { NextResponse } from "next/server"
import { isLabContextError, requireLabAccess } from "@/lib/lab/access"
import { fetchLabWorklist } from "@/lib/lab/worklist"

export const dynamic = "force-dynamic"

/** Results waiting for a senior: entered, not yet authorised. Paged, one query. */
export async function GET(request: Request) {
  const ctx = await requireLabAccess("result.verify")
  if (isLabContextError(ctx)) return ctx

  const params = new URL(request.url).searchParams
  const { orders, nextCursor, error } = await fetchLabWorklist(ctx, {
    view: "verify",
    section: params.get("section"),
    cursor: params.get("cursor"),
    limit: Number(params.get("limit")) || 50,
  })
  if (error) return NextResponse.json({ error }, { status: 500 })

  const items = orders.map((o) => ({
    orderId: o.id,
    testName: o.testName,
    loincCode: o.loincCode,
    section: o.section,
    urgency: o.urgency,
    accessionNumber: o.accessionNumber,
    patientName: o.patientName,
    status: o.status,
    result: o.hasResult
      ? {
          id: o.resultId,
          resultValue: o.resultValue ?? "",
          unit: o.unit,
          referenceRange: o.referenceRange,
          isCritical: o.isCritical,
          isAbnormal: Boolean(o.flag && o.flag !== "N"),
          flag: o.flag,
          analyzer: null,
          source: null,
          enteredAt: null,
        }
      : null,
  }))
  return NextResponse.json({ items, nextCursor, source: "database" })
}
