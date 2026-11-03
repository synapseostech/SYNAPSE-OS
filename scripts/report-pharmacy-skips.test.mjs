import assert from "node:assert/strict"
import { test } from "node:test"
import { DECLARED_SKIPS, classifySkips, collectSkips } from "./report-pharmacy-skips.mjs"

const ROOT = "/repo/apps/pharmacy"

function report(files, { pending } = {}) {
  const testResults = files.map(({ file, skipped, passed = 0 }) => ({
    name: `${ROOT}/${file}`,
    assertionResults: [
      ...Array.from({ length: skipped }, () => ({ status: "skipped" })),
      ...Array.from({ length: passed }, () => ({ status: "passed" })),
    ],
  }))
  const skippedTotal = files.reduce((sum, entry) => sum + entry.skipped, 0)
  return { testResults, numPendingTests: pending ?? skippedTotal }
}

test("counts skips per file and ignores files that ran", () => {
  const { rows, skippedTotal } = collectSkips(
    report([
      { file: "lib/a.test.ts", skipped: 2, passed: 3 },
      { file: "lib/b.test.ts", passed: 4 },
    ]),
  )
  assert.equal(skippedTotal, 2)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].file, `${ROOT}/lib/a.test.ts`)
  assert.equal(rows[0].skipped, 2)
})

test("accepts the declared environment-blocked files", () => {
  const declared = ["lib/a.test.ts", "lib/b.test.ts"]
  const result = classifySkips(report(declared.map((file) => ({ file, skipped: 1 }))), {
    "lib/a.test.ts": { class: "environment-blocked", reason: "needs a database" },
    "lib/b.test.ts": { class: "environment-blocked", reason: "needs a database" },
  }, ROOT)
  assert.deepEqual(result.undeclared, [])
  assert.deepEqual(result.invalid, [])
  assert.equal(result.countMismatch, false)
  assert.equal(result.declared.every((entry) => entry.observed?.skipped === 1), true)
})

test("fails a file that skips without a declaration", () => {
  const result = classifySkips(report([{ file: "lib/new.test.ts", skipped: 3 }]), {}, ROOT)
  assert.deepEqual(result.undeclared, [{ file: "lib/new.test.ts", skipped: 3 }])
})

test("flags a declaration whose class is not one of the three", () => {
  const result = classifySkips(report([{ file: "lib/a.test.ts", skipped: 1 }]), {
    "lib/a.test.ts": { class: "because-i-said-so", reason: "x" },
  }, ROOT)
  assert.deepEqual(result.invalid, ["lib/a.test.ts"])
})

test("flags a declaration with no reason", () => {
  const result = classifySkips(report([{ file: "lib/a.test.ts", skipped: 1 }]), {
    "lib/a.test.ts": { class: "optional", reason: "  " },
  }, ROOT)
  assert.deepEqual(result.invalid, ["lib/a.test.ts"])
})

test("fails when the report's pending count disagrees with the files", () => {
  const result = classifySkips(report([{ file: "lib/a.test.ts", skipped: 1 }], { pending: 4 }), {
    "lib/a.test.ts": { class: "optional", reason: "not needed for cut-over" },
  }, ROOT)
  assert.equal(result.countMismatch, true)
})

test("marks a declared file that ran instead of skipping", () => {
  const result = classifySkips(report([{ file: "lib/a.test.ts", passed: 2 }]), {
    "lib/a.test.ts": { class: "environment-blocked", reason: "needs a database" },
  }, ROOT)
  assert.equal(result.declared[0].observed, null)
  assert.equal(result.skippedTotal, 0)
})

test("every real declaration names a pharmacy test file that exists", async () => {
  const { existsSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = new URL("../apps/pharmacy/", import.meta.url).pathname
  for (const file of Object.keys(DECLARED_SKIPS)) {
    assert.equal(existsSync(join(root, file)), true, `${file} is declared but does not exist`)
  }
})
