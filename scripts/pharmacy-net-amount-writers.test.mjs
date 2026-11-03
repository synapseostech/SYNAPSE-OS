import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * pharmacy-net-amount-writers.test.mjs — keeps `pharmacy_transactions.net_amount`
 * meaning one thing.
 *
 * The column has carried two meanings: the Tally importer stored the pre-tax
 * total in it while the edit route stored what the customer owed. A reader
 * cannot tell which writer produced a given row, so every new write must go
 * through `netAmountFor` (apps/pharmacy/lib/pos/net-amount.ts).
 *
 * This is a source scan, not a behavioural test: it catches a writer that
 * bypasses the helper, which no unit test can see. The sites below that read
 * the column and re-shape it for a response are listed with the reason they are
 * read-side; anything else is reported.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const appRoot = join(root, "apps", "pharmacy")

/** Read-side projections: they map an existing row into a response shape. */
const READ_SIDE = new Map([
  ["apps/pharmacy/lib/pos/sale-ledger.ts", "maps an existing row into LedgerSaleRow / legacy API shape"],
  ["apps/pharmacy/app/api/admin/refunds/route.ts", "maps a voided POS sale into the refund list"],
  [
    "apps/pharmacy/app/api/admin/reports/route.ts",
    "derives one revenue basis from total_amount/discount/tax rather than trusting the stored column",
  ],
])

const HELPERS = /netAmountFor\(/

/** `net_amount: number` in a type literal is a declaration, not a write. */
const TYPE_MEMBER = /^\s*net_amount\??\s*:\s*(number|string|unknown|any|bigint)\b/

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.test\.(ts|tsx)$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/** All writes of net_amount that do not go through the helper. */
function findOffenders(files) {
  const offenders = []
  for (const { path, text } of files) {
    const rel = relative(root, path).split("\\").join("/")
    if (READ_SIDE.has(rel)) continue
    text.split("\n").forEach((line, index) => {
      if (!/\bnet_amount\s*:/.test(line)) return
      if (TYPE_MEMBER.test(line)) return
      if (HELPERS.test(line)) return
      offenders.push({ file: rel, line: index + 1, text: line.trim() })
    })
  }
  return offenders
}

test("every net_amount write goes through netAmountFor", () => {
  const files = sourceFiles(appRoot).map((path) => ({ path, text: readFileSync(path, "utf8") }))
  assert.ok(files.length > 50, `the scan found only ${files.length} source files, which cannot be right`)

  const offenders = findOffenders(files)
  assert.deepEqual(
    offenders,
    [],
    `net_amount written without netAmountFor (see lib/pos/net-amount.ts for the contract):\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
  )
})

test("the scan sees a writer that bypasses the helper (canary against a vacuous pass)", () => {
  const offenders = findOffenders([
    { path: join(appRoot, "lib", "tally", "apply.ts"), text: "        net_amount: money(sale.total)," },
  ])
  assert.equal(offenders.length, 1)
  assert.match(offenders[0].text, /money\(sale\.total\)/)
})

test("the scan accepts the helper and ignores test files and read-side projections", () => {
  const offenders = findOffenders([
    { path: join(appRoot, "app", "api", "x", "route.ts"), text: "net_amount: netAmountFor({ totalAmount: 1, discount: 0, tax: 0 })," },
    { path: join(appRoot, "lib", "pos", "sale-ledger.ts"), text: "net_amount: Number(s.net_amount ?? 0)," },
  ])
  assert.deepEqual(offenders, [])
})
