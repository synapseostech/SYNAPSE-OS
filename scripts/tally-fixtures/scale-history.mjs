#!/usr/bin/env node
/**
 * A synthetic pharmacy history at the scale of a real customer export, in the
 * exact file shapes tally-export-history.ps1 writes: one masters file and one
 * day book per month.
 *
 *   node scripts/tally-fixtures/scale-history.mjs [outDir] [--seed=N] [--items=N] [--sales-per-day=N]
 *
 * Every name and number is invented. The shape follows the SADIO archive as the
 * readiness report measured it — ~1,800 items, ~26,000 vouchers over thirteen
 * months, cash sales, purchases from ~27 suppliers, near-daily physical counts,
 * every allocation named "Primary Batch", no expiry anywhere — plus what that
 * archive lacked and a re-export will carry: masters with opening stock,
 * costing method, the financial-year start, and Tally's closing figures.
 *
 * The closing figures are computed here, independently of the importer, the
 * way Tally's default costing method computes them: per financial year,
 * opening value plus inward value over opening quantity plus inward quantity,
 * the rate rounded to five decimals, a purchase return taking its quantity and
 * value back out. Sales and physical counts change quantity, not the rate.
 * That model is this repository's reading of Tally's Average Cost; it is the
 * thing a run on a real Tally install must confirm, not something this file
 * can prove.
 *
 * Writes `expected.json` beside the XML with every closing figure, so a journey
 * can compare the database with Tally's position without re-deriving it.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? Number(hit.split("=")[1]) : fallback
}
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? "scripts/tally-fixtures/out/scale")
const SEED = flag("seed", 20261115)
const ITEM_COUNT = flag("items", 1800)
const SALES_PER_DAY = flag("sales-per-day", 64)
const PURCHASES_PER_DAY = 3.5
const COUNTS_PER_DAY = 1.2

export const SCALE_COMPANY = "ZZ Scale History Pharmacy"
const BOOKS_FROM = "2025-10-17"
const CUTOFF = "2026-10-31"
/** Uganda's financial year; the history crosses its boundary on 2026-07-01. */
const FY_START = "2025-07-01"
const BATCH = "Primary Batch"
const UNIT = "Nos"

// Mulberry32: small, fast, and the same sequence on every machine.
let state = SEED >>> 0
function random() {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (low, high) => low + Math.floor(random() * (high - low + 1))
const pick = (list) => list[Math.floor(random() * list.length)]
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100
const round5 = (value) => Math.round((value + Number.EPSILON) * 100_000) / 100_000
const money = (value) => value.toFixed(2)
const compact = (iso) => iso.replace(/-/g, "")
const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
function fyStartFor(iso) {
  const monthDay = FY_START.slice(5)
  const same = `${iso.slice(0, 4)}-${monthDay}`
  return same <= iso ? same : `${Number(iso.slice(0, 4)) - 1}-${monthDay}`
}

// ------------------------------------------------------------------ items
const FORMS = ["Tab", "Cap", "Syrup", "Susp", "Inj", "Cream", "Drops", "Sachet"]
const items = []
for (let index = 0; index < ITEM_COUNT; index += 1) {
  const cost = between(2, 400) * 50
  const opening = random() < 0.6 ? between(20, 200) : 0
  items.push({
    name: `ZZ Item ${String(index + 1).padStart(4, "0")} ${pick(FORMS)} ${between(1, 99) * 5}mg`,
    cost,
    price: Math.round((cost * 1.4) / 50) * 50,
    quantity: opening,
    // The Average Cost basis for the current financial year.
    inwardQuantity: opening,
    inwardValue: round2(opening * cost),
    period: fyStartFor(BOOKS_FROM),
    openingQuantity: opening,
    openingValue: round2(opening * cost),
  })
}
const suppliers = Array.from({ length: 27 }, (_, index) => `ZZ Supplier ${String(index + 1).padStart(2, "0")}`)

function enterYear(item, date) {
  const period = fyStartFor(date)
  if (item.period === period) return
  const rate = item.inwardQuantity > 0 ? round5(item.inwardValue / item.inwardQuantity) : 0
  item.inwardQuantity = item.quantity
  item.inwardValue = round2(item.quantity * rate)
  item.period = period
}

// --------------------------------------------------------------- vouchers
let guidCounter = 0
const guid = () => `5c000000-0000-4000-8000-${String((guidCounter += 1)).padStart(12, "0")}`
const ledgers = new Map([
  ["Cash-in-hand", 0],
  ["Sales Accounts", 0],
  ["Purchase Accounts", 0],
  ...suppliers.map((name) => [name, 0]),
])
const post = (name, debit) => ledgers.set(name, round2((ledgers.get(name) ?? 0) + debit))

const vouchersByMonth = new Map()
const counts = { sales: 0, purchases: 0, physical: 0, inventoryLines: 0 }
let number = 0

function stockLine(item, quantity, rate, inbound, element = "ALLINVENTORYENTRIES.LIST") {
  const amount = (inbound ? 1 : -1) * round2(quantity * rate)
  counts.inventoryLines += 1
  return (
    `<${element}><STOCKITEMNAME>${esc(item.name)}</STOCKITEMNAME>` +
    `<ISDEEMEDPOSITIVE>${inbound ? "Yes" : "No"}</ISDEEMEDPOSITIVE><RATE>${money(rate)}/${UNIT}</RATE>` +
    `<AMOUNT>${money(amount)}</AMOUNT><ACTUALQTY>${quantity} ${UNIT}</ACTUALQTY>` +
    `<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>${BATCH}</BATCHNAME>` +
    `<ACTUALQTY>${quantity} ${UNIT}</ACTUALQTY><AMOUNT>${money(amount)}</AMOUNT></BATCHALLOCATIONS.LIST></${element}>`
  )
}
function ledgerLine(name, debit) {
  post(name, debit)
  return (
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(name)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>${debit > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${money(debit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
  )
}
function voucher(type, date, party, body) {
  const id = guid()
  number += 1
  const month = date.slice(0, 7)
  const list = vouchersByMonth.get(month) ?? []
  list.push(
    `<VOUCHER VCHTYPE="${type}" GUID="${id}"><DATE>${compact(date)}</DATE><GUID>${id}</GUID>` +
      `<VOUCHERNUMBER>${number}</VOUCHERNUMBER>${party ? `<PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>` : ""}` +
      `<CURRENCYNAME>UGX</CURRENCYNAME>${body}</VOUCHER>`,
  )
  vouchersByMonth.set(month, list)
}
const times = (mean) => Math.floor(mean) + (random() < mean - Math.floor(mean) ? 1 : 0)

for (let date = BOOKS_FROM; date <= CUTOFF; date = addDays(date, 1)) {
  for (const item of items) enterYear(item, date)

  // Purchases first in the day's export order: a pharmacy receives, then sells.
  for (let p = 0; p < times(PURCHASES_PER_DAY); p += 1) {
    const supplier = pick(suppliers)
    const lines = []
    let total = 0
    const chosen = new Set()
    for (let l = 0; l < between(2, 5); l += 1) {
      const item = pick(items)
      if (chosen.has(item)) continue
      chosen.add(item)
      const quantity = between(20, 200)
      // Prices drift: this is what separates Tally's average from a moving one.
      const rate = Math.round((item.cost * (0.9 + random() * 0.3)) / 10) * 10
      const amount = round2(quantity * rate)
      item.quantity += quantity
      item.inwardQuantity += quantity
      item.inwardValue = round2(item.inwardValue + amount)
      total = round2(total + amount)
      lines.push(stockLine(item, quantity, rate, true))
    }
    if (lines.length === 0) continue
    counts.purchases += 1
    voucher("Purchase", date, supplier, ledgerLine("Purchase Accounts", total) + ledgerLine(supplier, -total) + lines.join(""))
  }

  for (let s = 0; s < times(SALES_PER_DAY); s += 1) {
    const lines = []
    let total = 0
    const chosen = new Set()
    for (let l = 0; l < between(1, 3); l += 1) {
      const item = pick(items)
      if (chosen.has(item) || item.quantity < 1) continue
      chosen.add(item)
      const quantity = Math.min(item.quantity, between(1, 5))
      item.quantity -= quantity
      total = round2(total + quantity * item.price)
      lines.push(stockLine(item, quantity, item.price, false))
    }
    if (lines.length === 0) continue
    counts.sales += 1
    voucher("Cash Sale", date, "Cash-in-hand", ledgerLine("Cash-in-hand", total) + ledgerLine("Sales Accounts", -total) + lines.join(""))
  }

  for (let c = 0; c < times(COUNTS_PER_DAY); c += 1) {
    const lines = []
    const chosen = new Set()
    for (let l = 0; l < between(1, 4); l += 1) {
      const item = pick(items)
      if (chosen.has(item)) continue
      chosen.add(item)
      // A count finds a little more or a little less than the book.
      const counted = Math.max(0, item.quantity + between(-2, 2))
      item.quantity = counted
      lines.push(stockLine(item, counted, item.cost, true, "INVENTORYENTRIES.LIST"))
    }
    if (lines.length === 0) continue
    counts.physical += 1
    voucher("Physical Stock", date, "", lines.join(""))
  }
}
for (const item of items) enterYear(item, CUTOFF)

// ----------------------------------------------------------------- closing
let closingStockValue = 0
const expectedItems = items.map((item) => {
  const rate = item.inwardQuantity > 0 ? round5(item.inwardValue / item.inwardQuantity) : 0
  const value = round2(item.quantity * rate)
  closingStockValue = round2(closingStockValue + value)
  return { name: item.name, quantity: item.quantity, value, rate }
})
const openingStockValue = round2(items.reduce((sum, item) => sum + item.openingValue, 0))

const envelope = (inner) => `<ENVELOPE><BODY><DATA>${inner}</DATA></BODY></ENVELOPE>`
const companyRecord = (from, to, withYear) =>
  `<COMPANY NAME="${SCALE_COMPANY}"><COMPANYNAME>${SCALE_COMPANY}</COMPANYNAME>` +
  `<SVFROMDATE>${compact(from)}</SVFROMDATE><SVTODATE>${compact(to)}</SVTODATE>` +
  (withYear ? `<STARTINGFROM>${compact(FY_START)}</STARTINGFROM>` : "") +
  "</COMPANY>"
const ledgerMaster = (name, parent, opening, closing) =>
  `<LEDGER NAME="${esc(name)}"><PARENT>${parent}</PARENT><OPENINGBALANCE>${money(opening)}</OPENINGBALANCE>` +
  `<CLOSINGBALANCE>${money(closing)}</CLOSINGBALANCE></LEDGER>`

const masters = envelope(
  [
    companyRecord(BOOKS_FROM, CUTOFF, true),
    '<GROUP NAME="Current Assets"/>',
    '<GROUP NAME="Cash-in-Hand"><PARENT>Current Assets</PARENT></GROUP>',
    '<GROUP NAME="Current Liabilities"/>',
    '<GROUP NAME="Sundry Creditors"><PARENT>Current Liabilities</PARENT></GROUP>',
    '<GROUP NAME="Capital Account"/>',
    '<GROUP NAME="Sales Accounts"/>',
    '<GROUP NAME="Purchase Accounts"/>',
    // Opening stock balanced against capital, so the opening journal balances.
    ledgerMaster("Opening Stock Holding", "Current Assets", openingStockValue, openingStockValue),
    ledgerMaster("Capital", "Capital Account", -openingStockValue, -openingStockValue),
    ...[...ledgers].map(([name, closing]) =>
      ledgerMaster(
        name,
        name === "Cash-in-hand"
          ? "Cash-in-Hand"
          : name === "Sales Accounts"
            ? "Sales Accounts"
            : name === "Purchase Accounts"
              ? "Purchase Accounts"
              : "Sundry Creditors",
        0,
        closing,
      ),
    ),
    `<UNIT NAME="${UNIT}"><SYMBOL>nos</SYMBOL></UNIT>`,
    '<GODOWN NAME="Main Location"/>',
    ...items.map((item, index) => {
      const closing = expectedItems[index]
      return (
        `<STOCKITEM NAME="${esc(item.name)}"><PARENT>Primary</PARENT><BASEUNITS>${UNIT}</BASEUNITS>` +
        "<COSTINGMETHOD>Avg. Cost</COSTINGMETHOD><ISBATCHWISEON>Yes</ISBATCHWISEON>" +
        `<OPENINGBALANCE>${item.openingQuantity} ${UNIT}</OPENINGBALANCE><OPENINGRATE>${money(item.cost)}</OPENINGRATE>` +
        `<OPENINGVALUE>${money(item.openingValue)}</OPENINGVALUE>` +
        `<CLOSINGBALANCE>${closing.quantity} ${UNIT}</CLOSINGBALANCE><CLOSINGVALUE>${money(closing.value)}</CLOSINGVALUE>` +
        (item.openingQuantity > 0
          ? `<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>${BATCH}</BATCHNAME>` +
            `<OPENINGBALANCE>${item.openingQuantity} ${UNIT}</OPENINGBALANCE><OPENINGVALUE>${money(item.openingValue)}</OPENINGVALUE>` +
            "</BATCHALLOCATIONS.LIST>"
          : "") +
        "</STOCKITEM>"
      )
    }),
  ].join(""),
)

mkdirSync(outDir, { recursive: true })
const written = []
const write = (name, text) => {
  writeFileSync(join(outDir, name), text)
  written.push({ name, bytes: Buffer.byteLength(text) })
}
write(`2-masters-${compact(BOOKS_FROM)}-${compact(CUTOFF)}.xml`, masters)
for (let month = BOOKS_FROM.slice(0, 7); month <= CUTOFF.slice(0, 7); ) {
  const [year, mon] = month.split("-").map(Number)
  const first = month === BOOKS_FROM.slice(0, 7) ? BOOKS_FROM : `${month}-01`
  const last = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10)
  const end = last > CUTOFF ? CUTOFF : last
  write(
    `3-daybook-${compact(first)}-${compact(end)}.xml`,
    envelope(companyRecord(first, end, false) + (vouchersByMonth.get(month) ?? []).join("")),
  )
  month = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`
}

const expected = {
  company: SCALE_COMPANY,
  booksFrom: BOOKS_FROM,
  cutoff: CUTOFF,
  financialYearStart: FY_START,
  seed: SEED,
  counts: { ...counts, vouchers: counts.sales + counts.purchases + counts.physical, items: items.length },
  openingStockValue,
  closingStockValue,
  ledgers: Object.fromEntries(ledgers),
  items: expectedItems,
}
writeFileSync(join(outDir, "expected.json"), JSON.stringify(expected))
for (const file of written) console.log(`${file.name}\t${(file.bytes / 1e6).toFixed(2)} MB`)
console.log(JSON.stringify(expected.counts), `closing stock ${closingStockValue}`)
