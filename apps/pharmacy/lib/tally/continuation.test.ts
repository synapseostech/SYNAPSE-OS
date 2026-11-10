import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase, filtersOf, type FakeOperation } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
}))

vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))

import {
  continuationSessionOf,
  evaluateContinuation,
  TALLY_CONTINUATION_UNKNOWN,
} from "./continuation"
import { findCutoverBlockingSession } from "./cutover"

type CheckpointRow = {
  tenant_id: string
  id: string
  company_key: string
  session_id: string
  through_date: string
}

function checkpoint(overrides: Partial<CheckpointRow> = {}): CheckpointRow {
  return {
    tenant_id: "tenant-1",
    id: "checkpoint-1",
    company_key: "company-guid",
    session_id: "session-1",
    through_date: "2026-03-31",
    ...overrides,
  }
}

/** Answers the checkpoint query with the latest row that matches the filters. */
function checkpointClient(rows: CheckpointRow[]) {
  return fakeSupabase((operation) => {
    const filters = filtersOf(operation)
    const matching = rows.filter((row) =>
      Object.entries(filters).every(
        ([column, value]) => (row as Record<string, unknown>)[column] === value,
      ),
    )
    const latest = [...matching].sort((a, b) =>
      a.through_date < b.through_date ? 1 : -1,
    )[0]
    return { data: latest ?? null }
  }).client
}

function input(overrides: Partial<Parameters<typeof evaluateContinuation>[0]> = {}) {
  return {
    tenantId: "tenant-1",
    mapping: { continuationOf: "session-1" } as Record<string, unknown>,
    companyKey: "company-guid",
    conversionDate: "2026-04-01",
    mode: "replay" as const,
    client: checkpointClient([checkpoint()]),
    ...overrides,
  }
}

describe("continuationSessionOf", () => {
  it("returns the declared session id", () => {
    expect(continuationSessionOf({ continuationOf: "session-1" })).toBe("session-1")
  })

  it("trims a padded value", () => {
    expect(continuationSessionOf({ continuationOf: "  session-1  " })).toBe("session-1")
  })

  it("ignores a blank, missing or non-string value", () => {
    expect(continuationSessionOf({})).toBeNull()
    expect(continuationSessionOf({ continuationOf: "   " })).toBeNull()
    expect(continuationSessionOf({ continuationOf: 42 })).toBeNull()
  })
})

describe("evaluateContinuation", () => {
  it("reports none when the session does not claim a continuation", async () => {
    const result = await evaluateContinuation(input({ mapping: {} }))
    expect(result).toEqual({ kind: "none" })
  })

  it("refuses a snapshot laid on top of the history", async () => {
    const result = await evaluateContinuation(input({ mode: "opening" }))
    expect(result).toMatchObject({ kind: "invalid", code: "TALLY_CONTINUATION_MODE" })
  })

  it("refuses a session that never closed against a checkpoint", async () => {
    const result = await evaluateContinuation(
      input({ client: checkpointClient([checkpoint({ session_id: "another-session" })]) }),
    )
    expect(result).toMatchObject({
      kind: "invalid",
      code: "TALLY_CONTINUATION_NO_CHECKPOINT",
    })
  })

  it("refuses a continuation for a different company", async () => {
    const result = await evaluateContinuation(input({ companyKey: "other-company" }))
    expect(result).toMatchObject({ kind: "invalid", code: "TALLY_CONTINUATION_COMPANY" })
  })

  it("refuses a continuation of a period the company has already passed", async () => {
    const result = await evaluateContinuation(
      input({
        client: checkpointClient([
          checkpoint(),
          checkpoint({ id: "checkpoint-2", session_id: "session-2", through_date: "2026-06-30" }),
        ]),
      }),
    )
    expect(result).toMatchObject({
      kind: "invalid",
      code: "TALLY_CONTINUATION_STALE",
      continueFrom: "session-2",
    })
  })

  it("refuses a period that does not start after the previous close", async () => {
    const sameDay = await evaluateContinuation(input({ conversionDate: "2026-03-31" }))
    expect(sameDay).toMatchObject({ kind: "invalid", code: "TALLY_CONTINUATION_PERIOD" })

    const earlier = await evaluateContinuation(input({ conversionDate: "2026-02-01" }))
    expect(earlier).toMatchObject({ kind: "invalid", code: "TALLY_CONTINUATION_PERIOD" })
  })

  it("accepts a replay for the same company starting after the close", async () => {
    const result = await evaluateContinuation(input())
    expect(result).toEqual({
      kind: "valid",
      checkpoint: {
        id: "checkpoint-1",
        companyKey: "company-guid",
        sessionId: "session-1",
        throughDate: "2026-03-31",
      },
    })
  })

  it("reads the latest checkpoint for the company, not merely any row", async () => {
    const result = await evaluateContinuation(
      input({
        client: checkpointClient([
          checkpoint({ through_date: "2026-01-31" }),
          checkpoint({ id: "checkpoint-2", through_date: "2026-03-31" }),
        ]),
      }),
    )
    expect(result).toMatchObject({
      kind: "valid",
      checkpoint: { id: "checkpoint-2", throughDate: "2026-03-31" },
    })
  })
})

describe("findCutoverBlockingSession", () => {
  const COMPLETE = { id: "session-1", completed_at: "2026-03-31T00:00:00.000Z" }

  /**
   * `complete` is the row the cut-over query returns — null when the pharmacy
   * has no open (unrolled-back) completed session, which is what Postgres
   * answers once `reversedAt` is set.
   */
  function useCutover(
    sessions: Record<string, Record<string, unknown>>,
    complete: unknown = COMPLETE,
  ) {
    const fake = fakeSupabase((operation) => {
      if (operation.selected[0] === "id, completed_at") return { data: complete }
      const found = sessions[String(filtersOf(operation).id)]
      return { data: found ? { ai_mapping: found } : null }
    })
    m.db = { client: fake.client, operations: fake.operations }
    return fake
  }

  beforeEach(() => {
    m.db = { client: null, operations: [] }
  })

  it("blocks an ordinary second session", async () => {
    useCutover({ "session-2": {} })
    const blocked = await findCutoverBlockingSession("tenant-1", "session-2")
    expect(blocked).toMatchObject({ sessionId: "session-1" })
  })

  it("lets the completed session itself through", async () => {
    useCutover({})
    expect(await findCutoverBlockingSession("tenant-1", "session-1")).toBeNull()
  })

  it("lets a declared continuation of the completed session through", async () => {
    useCutover({ "session-2": { continuationOf: "session-1" } })
    expect(await findCutoverBlockingSession("tenant-1", "session-2")).toBeNull()
  })

  it("blocks a session that continues some other session", async () => {
    useCutover({ "session-2": { continuationOf: "session-old" } })
    const blocked = await findCutoverBlockingSession("tenant-1", "session-2")
    expect(blocked).toMatchObject({ sessionId: "session-1" })
  })

  it("blocks nothing when no cut-over has completed", async () => {
    useCutover({}, null)
    expect(await findCutoverBlockingSession("tenant-1", "session-2")).toBeNull()
  })

  it("asks the database for a completed session that was not rolled back", async () => {
    const fake = useCutover({})
    await findCutoverBlockingSession("tenant-1", "session-2")
    const cutoverQuery = fake.operations.find(
      (operation) => operation.selected[0] === "id, completed_at",
    )
    expect(cutoverQuery && filtersOf(cutoverQuery)).toMatchObject({
      status: "complete",
      "ai_mapping->>reversedAt": null,
    })
  })
})

describe("TALLY_CONTINUATION_UNKNOWN", () => {
  it("names the refusal and explains the remedy", () => {
    expect(TALLY_CONTINUATION_UNKNOWN.code).toBe("TALLY_CONTINUATION_UNKNOWN")
    expect(TALLY_CONTINUATION_UNKNOWN.humanMessage).toContain("Start a fresh cut-over")
  })
})
