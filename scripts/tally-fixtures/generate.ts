/**
 * Writes the anonymised Tally cut-over fixtures to disk for a manual
 * upload → preview → apply walk-through.
 *
 *   node --experimental-strip-types scripts/tally-fixtures/generate.ts [outDir]
 *
 * Default output is scripts/tally-fixtures/out, which is gitignored. The bytes
 * come from the same builders the tests round-trip, so what you upload here is
 * exactly what `lib/tally/fixtures.test.ts` covers.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  FIXTURE_COMPANY,
  buildFixtureCsv,
  buildFixtureWorkbook,
  buildFixtureXml,
} from "../../apps/pharmacy/lib/tally/fixtures.ts"

const outDir = resolve(process.argv[2] ?? join(import.meta.dirname, "out"))
mkdirSync(outDir, { recursive: true })

const files: Array<[string, string | Uint8Array]> = [
  ["test-pharmacy-tally.xml", buildFixtureXml()],
  ["test-pharmacy-tally.xlsx", buildFixtureWorkbook()],
  ["test-pharmacy-tally.csv", buildFixtureCsv()],
]

for (const [name, contents] of files) {
  const path = join(outDir, name)
  writeFileSync(path, contents)
  const bytes = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength
  console.log(`${path} (${bytes} bytes)`)
}

console.log(`Fixtures written for "${FIXTURE_COMPANY}" — synthetic data only.`)
