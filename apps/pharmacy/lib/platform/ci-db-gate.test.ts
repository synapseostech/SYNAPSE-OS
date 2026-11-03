import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  PRODUCTION_PROJECT_REF,
  assertDisposableDatabaseTarget,
  hasDb,
  hasPartialDbConfig,
  supabaseProjectRef,
} from "./test-db-guard"

/** Non-skippable gate: CI must not partially configure DB-backed integration tests. */
describe("database test prerequisites (P0-004 / connected care spine)", () => {
  it("must provide either both DB vars or neither", () => {
    expect(hasPartialDbConfig).toBe(false)
    if (process.env.CI === "true") {
      expect(hasDb).toBe(true)
    }
  })
})

describe("production database guard", () => {
  it("reads the project ref out of a supabase.co URL and ignores everything else", () => {
    expect(supabaseProjectRef("https://jbojujxpyxsdiukmrwzs.supabase.co")).toBe(
      "jbojujxpyxsdiukmrwzs",
    )
    expect(supabaseProjectRef("https://QFQAKZMJATSZISUQJWON.supabase.co/")).toBe(
      PRODUCTION_PROJECT_REF,
    )
    expect(supabaseProjectRef("http://127.0.0.1:54321")).toBeNull()
    expect(supabaseProjectRef("https://pharmacy.example.org")).toBeNull()
    expect(supabaseProjectRef("not a url")).toBeNull()
  })

  it("refuses production under any declaration", () => {
    expect(() => assertDisposableDatabaseTarget(PRODUCTION_PROJECT_REF, "")).toThrow(/production/)
    expect(() =>
      assertDisposableDatabaseTarget(PRODUCTION_PROJECT_REF, PRODUCTION_PROJECT_REF),
    ).toThrow(/production/)
  })

  it("refuses an undeclared remote project and a declaration for a different one", () => {
    expect(() => assertDisposableDatabaseTarget("jbojujxpyxsdiukmrwzs", "")).toThrow(
      /no acceptance target was declared/,
    )
    expect(() =>
      assertDisposableDatabaseTarget("jbojujxpyxsdiukmrwzs", "abcdefghijklmnopqrst"),
    ).toThrow(/declares abcdefghijklmnopqrst/)
  })

  it("accepts the declared acceptance project and loopback URLs", () => {
    expect(() =>
      assertDisposableDatabaseTarget("jbojujxpyxsdiukmrwzs", "jbojujxpyxsdiukmrwzs"),
    ).not.toThrow()
    expect(() => assertDisposableDatabaseTarget(null, "")).not.toThrow()
  })

  it("keeps the production ref in step with the acceptance isolation script", () => {
    // Two modules refuse the same project. A silent divergence would let one of
    // them guard a database the other refuses.
    const script = readFileSync(
      join(__dirname, "../../../../scripts/e2e-acceptance-isolation.mjs"),
      "utf8",
    )
    const declared = /PRODUCTION_PROJECT_REF = "([^"]+)"/.exec(script)?.[1]
    expect(declared).toBe(PRODUCTION_PROJECT_REF)
  })
})
