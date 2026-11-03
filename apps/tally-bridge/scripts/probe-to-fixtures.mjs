#!/usr/bin/env node
/**
 * Turns a tally-probe.ps1 output folder into a fixture set the rehearsal can use.
 *
 * The one thing the synthetic fixtures cannot answer is whether the client's own
 * Tally build emits the company marker the bridge requires. Only a capture from
 * that installation can settle it — and that capture holds a real business's
 * books. So every company, group, ledger, stock item, unit, godown, voucher type,
 * party, narration and voucher number is rewritten to a synthetic name, and the
 * result is re-read and refused if any original survives.
 *
 * Amounts and dates are kept: they are what makes a replay meaningful, and they
 * name nobody. Nothing from the probe folder other than the three XML responses
 * is read — in particular not the report, which carries the company name and
 * period.
 *
 *   node apps/tally-bridge/scripts/probe-to-fixtures.mjs --in <probe dir> --out <dir>
 *
 * The output defaults to a temporary directory. Pointing it inside the repository
 * is refused unless --force is passed, because a captured set must not be
 * committed by accident.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "../../..")

const SOURCES = [
  ["companies.xml", "1-companies.xml"],
  ["masters.xml", "2-masters.xml"],
  ["daybook.xml", "3-day-book.xml"],
]

const KINDS = {
  COMPANY: "Captured Company",
  GROUP: "Group",
  STOCKGROUP: "Stock Group",
  LEDGER: "Ledger",
  STOCKITEM: "Item",
  UNIT: "Unit",
  GODOWN: "Godown",
  VOUCHERTYPE: "Voucher Type",
  NARRATION: "Narration",
  VOUCHERNUMBER: "VCH",
}

/**
 * Every place a real name can sit, most specific first. The first pattern to
 * claim a value decides what kind of thing it is, so a company that shares its
 * text with a ledger is still renamed as a company.
 */
const NAME_SOURCES = [
  ["COMPANY", /<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["COMPANY", /<COMPANYNAME>([^<]{1,400})<\/COMPANYNAME>/gi],
  ["GROUP", /<GROUP\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["STOCKGROUP", /<STOCKGROUP\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["LEDGER", /<LEDGER\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["LEDGER", /<LEDGERNAME>([^<]{1,400})<\/LEDGERNAME>/gi],
  ["LEDGER", /<PARTYLEDGERNAME>([^<]{1,400})<\/PARTYLEDGERNAME>/gi],
  ["LEDGER", /<PARTYNAME>([^<]{1,400})<\/PARTYNAME>/gi],
  ["STOCKITEM", /<STOCKITEM\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["STOCKITEM", /<STOCKITEMNAME>([^<]{1,400})<\/STOCKITEMNAME>/gi],
  ["UNIT", /<UNIT\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["UNIT", /<UNITNAME>([^<]{1,400})<\/UNITNAME>/gi],
  ["GODOWN", /<GODOWN\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["VOUCHERTYPE", /<VOUCHERTYPE\b[^>]*?\bNAME="([^"]{1,400})"/gi],
  ["VOUCHERTYPE", /<VOUCHERTYPENAME>([^<]{1,400})<\/VOUCHERTYPENAME>/gi],
  ["NARRATION", /<NARRATION>([\s\S]{0,4000}?)<\/NARRATION>/gi],
  ["VOUCHERNUMBER", /<VOUCHERNUMBER>([^<]{1,120})<\/VOUCHERNUMBER>/gi],
]

function usage(exitCode, message) {
  if (message) console.error(message)
  console.error(
    [
      "usage: node probe-to-fixtures.mjs --in <probe dir> [--out <dir>] [--force]",
      "",
      "  --in     the folder tally-probe.ps1 wrote (1-companies.xml, 2-masters.xml, 3-day-book.xml)",
      "  --out    where to write companies.xml, masters.xml and daybook.xml",
      `           (default: ${join(tmpdir(), "tally-capture")})`,
      "  --force  allow --out inside the repository; the converted set is still synthetic",
    ].join("\n"),
  )
  process.exit(exitCode)
}

function parseArgs(argv) {
  const options = { force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") usage(0)
    else if (arg === "--force") options.force = true
    else if (arg === "--in" || arg === "--out") {
      const value = argv[index + 1]
      if (!value) usage(2, `${arg} needs a directory.`)
      options[arg === "--in" ? "input" : "output"] = value
      index += 1
    } else usage(2, `Unknown argument: ${arg}`)
  }
  if (!options.input) usage(2, "--in is required.")
  options.output ??= join(tmpdir(), "tally-capture")
  return options
}

function insideRepository(path) {
  const full = resolve(path)
  return full === REPO || full.startsWith(`${REPO}/`)
}

/**
 * Name -> synthetic replacement for every original the documents contain.
 * Numbered by first appearance, so replaying the same capture twice produces the
 * same set and two people can discuss `Ledger 04` without writing down a real
 * account name.
 */
function buildRenameMap(documents) {
  const map = new Map()
  const counters = new Map()
  for (const [kind, pattern] of NAME_SOURCES) {
    for (const xml of documents) {
      for (const match of xml.matchAll(pattern)) {
        const value = match[1]
        if (!value || !value.trim() || map.has(value)) continue
        const count = (counters.get(kind) ?? 0) + 1
        counters.set(kind, count)
        const label = KINDS[kind] ?? "Value"
        map.set(
          value,
          kind === "COMPANY" ? `${label} ${count}` : `${label} ${String(count).padStart(2, "0")}`,
        )
      }
    }
  }
  return map
}

/**
 * Replaces through an intermediate token, so a synthetic name can never contain
 * a string that a later rule would rewrite again.
 */
function rewrite(xml, map) {
  const placeholders = new Map()
  let text = xml
  let index = 0
  for (const [original, synthetic] of [...map].sort((a, b) => b[0].length - a[0].length)) {
    const token = `\u0000${index}\u0000`
    placeholders.set(token, synthetic)
    text = text.split(original).join(token)
    index += 1
  }
  for (const [token, synthetic] of placeholders) text = text.split(token).join(synthetic)
  return text
}

/** Any original still readable in the output, ignoring a name its own replacement contains. */
function survivors(text, map) {
  return [...map].filter(
    ([original, synthetic]) => !synthetic.includes(original) && text.includes(original),
  )
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const input = resolve(options.input)
  const output = resolve(options.output)

  if (!existsSync(input)) usage(2, `No such folder: ${input}`)
  if (insideRepository(output) && !options.force) {
    usage(
      2,
      [
        `Refusing to write fixtures inside the repository (${output}).`,
        "A capture converted from real books must not be committed by accident.",
        "Use --out with a folder outside the repository, or pass --force once you have checked .gitignore.",
      ].join("\n"),
    )
  }

  const sources = SOURCES.map(([fixture, source]) => {
    const path = join(input, source)
    if (!existsSync(path)) usage(2, `Missing ${source} in ${input}. Run tally-probe.ps1 first.`)
    return [fixture, readFileSync(path, "utf8")]
  })

  const map = buildRenameMap(sources.map(([, xml]) => xml))
  const renamed = sources.map(([fixture, xml]) => [fixture, rewrite(xml, map)])

  for (const [fixture, xml] of renamed) {
    const left = survivors(xml, map)
    if (left.length > 0) {
      console.error(
        `Refusing to write ${fixture}: ${left.length} original name(s) survived the rewrite, e.g. ${left
          .slice(0, 3)
          .map(([original]) => JSON.stringify(original))
          .join(", ")}`,
      )
      process.exit(1)
    }
  }

  mkdirSync(output, { recursive: true })
  for (const [fixture, xml] of renamed) writeFileSync(join(output, fixture), xml)

  const count = (xml, tag) => (xml.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length
  const masters = renamed[1][1]
  const company = masters.match(/<COMPANYNAME>([^<]+)<\/COMPANYNAME>/i)?.[1]

  console.log(`Wrote a synthetic fixture set to ${output}`)
  console.log(`  companies.xml   ${count(renamed[0][1], "COMPANY")} companies`)
  console.log(
    `  masters.xml     ${count(masters, "LEDGER")} ledgers, ${count(masters, "STOCKITEM")} stock items`,
  )
  console.log(`  daybook.xml     ${count(renamed[2][1], "VOUCHER")} vouchers`)
  console.log(`  rewrote ${map.size} name(s)`)
  console.log("")
  if (!/<COMPANY\b/i.test(masters)) {
    console.log("  WARNING: this Tally build's All Masters carries no company marker.")
    console.log("  The bridge refuses such an export as TALLY_BRIDGE_COMPANY_UNVERIFIED,")
    console.log("  so the cut-over would stop there. Replay it to see the refusal:")
    console.log("")
  } else {
    console.log(`  All Masters names its company (${company}), so pinning will verify.`)
    console.log("")
  }
  console.log(`  SYNAPSE_FAKE_TALLY_FIXTURES=${output} node scripts/tally-rehearse.mjs`)
}

main()
