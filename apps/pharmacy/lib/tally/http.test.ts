import { describe, expect, it } from "vitest"
import { tallyErrorResponse } from "./http"
import { TallyConsolidationError } from "./consolidate"

describe("tallyErrorResponse", () => {
  it("answers a company mismatch with the operator's next step, not a 500", async () => {
    const response = tallyErrorResponse(
      new TallyConsolidationError("TALLY_CONSOLIDATION_COMPANY_MISMATCH"),
    )
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.code).toBe("TALLY_CONSOLIDATION_COMPANY_MISMATCH")
    expect(body.error).toMatch(/more than one Tally company/)
  })

  it("keeps the code on a failure it has no status for", async () => {
    const response = tallyErrorResponse(new Error("TALLY_SOMETHING_ELSE"))
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.code).toBe("TALLY_SOMETHING_ELSE")
    expect(body.error).toBe("The Tally file could not be processed.")
  })

  it("does not hand a whole sentence back as a code", async () => {
    const response = tallyErrorResponse(new Error("Something went wrong somewhere"))
    const body = await response.json()
    expect(body.code).toBeUndefined()
    expect(body.detail).toBeUndefined()
  })

  it("keeps what the failure carried after its code", async () => {
    const response = tallyErrorResponse(
      new Error("TALLY_CHUNK_WRITE_FAILED: mime type application/json is not supported"),
    )
    const body = await response.json()
    expect(body.code).toBe("TALLY_CHUNK_WRITE_FAILED")
    expect(body.detail).toBe("mime type application/json is not supported")
  })
})
