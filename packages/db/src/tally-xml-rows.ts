/**
 * Tally XML row reader.
 *
 * `tally-xml.ts` only discovers what an export contains. This module reads the
 * masters and vouchers out of it, using the same safety posture:
 *
 *   1. Any document containing `<!` (after comments are removed) is refused, so
 *      there is no DTD and no entity expansion to exploit.
 *   2. Input bytes, total tags, record count, per-record node count and captured
 *      text are all bounded.
 *   3. It is a reader. It never writes to a database and never invents a value
 *      Tally did not export.
 *
 * Tally's date and amount conventions are preserved rather than guessed at:
 * amounts are parsed through integer minor units, and a ledger entry's side
 * comes from `ISDEEMEDPOSITIVE` when present, else from the sign of `AMOUNT`.
 */

import { stripDelimited } from "./tally-xml"

const MAX_BYTES = 25 * 1024 * 1024
const MAX_TAGS = 2_000_000
const MAX_RECORDS = 250_000
const MAX_RECORD_NODES = 50_000
const MAX_TEXT = 4096
const MAX_WARNINGS = 200

/** Elements that carry a master or voucher. */
export const TALLY_XML_ROW_ELEMENTS = [
  "VOUCHER",
  "LEDGER",
  "GROUP",
  "STOCKITEM",
  "STOCKGROUP",
  "UNIT",
  "GODOWN",
  "COMPANY",
] as const

const RECORD_ELEMENTS = new Set<string>(TALLY_XML_ROW_ELEMENTS)

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

export type TallyXmlRowWarning =
  | "TAG_DEPTH_EXCEEDED"
  | "RECORD_NODE_LIMIT"
  | "UNCLOSED_RECORD"
  | "UNEXPECTED_CLOSE"
  | "MALFORMED_ATTRIBUTE"
  | "UNKNOWN_ENTITY"
  | "DATE_UNREADABLE"
  | "AMOUNT_UNREADABLE"
  | "QUANTITY_UNREADABLE"
  | "RECORD_LIMIT_REACHED"

export type TallyGroup = {
  guid?: string
  name: string
  parent?: string
}

export type TallyLedger = {
  guid?: string
  name: string
  parent?: string
  openingBalance?: number
  closingBalance?: number
  isBillWise: boolean
  email?: string
  phone?: string
  address?: string
  bills: TallyBillAllocation[]
}

export type TallyStockGroup = {
  guid?: string
  name: string
  parent?: string
}

export type TallyUnit = {
  guid?: string
  name: string
  symbol?: string
}

export type TallyGodown = {
  guid?: string
  name: string
  parent?: string
}

export type TallyStockItem = {
  guid?: string
  name: string
  parent?: string
  baseUnit?: string
  openingQuantity?: number
  openingRate?: number
  openingValue?: number
  closingQuantity?: number
  closingValue?: number
  batchWise: boolean
  batches: TallyBatchAllocation[]
}

export type TallyBillAllocation = {
  name: string
  billType?: string
  amount: number
  creditPeriodDays?: number
}

export type TallyLedgerLine = {
  ledgerName: string
  amount: number
  side: "debit" | "credit"
  isParty: boolean
  narration?: string
  bills: TallyBillAllocation[]
}

export type TallyBatchAllocation = {
  batchName?: string
  expiryDate?: string
  quantity?: number
  amount?: number
  godown?: string
}

export type TallyInventoryLine = {
  stockItemName: string
  quantity?: number
  unit?: string
  rate?: number
  amount: number
  godown?: string
  batches: TallyBatchAllocation[]
  ledgers: TallyLedgerLine[]
}

export type TallyVoucher = {
  guid?: string
  remoteId?: string
  type: string
  number?: string
  date?: string
  narration?: string
  partyLedgerName?: string
  currency?: string
  isCancelled: boolean
  ledgerLines: TallyLedgerLine[]
  inventoryLines: TallyInventoryLine[]
}

export type TallyXmlDocument = {
  company?: string
  companyGuid?: string
  currency?: string
  financialPeriod: { from?: string; to?: string }
  groups: TallyGroup[]
  ledgers: TallyLedger[]
  stockGroups: TallyStockGroup[]
  stockItems: TallyStockItem[]
  units: TallyUnit[]
  godowns: TallyGodown[]
  vouchers: TallyVoucher[]
  warnings: TallyXmlRowWarning[]
}

type XmlNode = {
  name: string
  attrs: Record<string, string>
  text: string
  children: XmlNode[]
}

// Parser input is an untrusted upload, so every quantifier runs against attacker
// chosen text. Bounded names and single (non-overlapping) whitespace runs keep the
// scans linear; `<\s*(\/?)\s*` and `([^<>]*?)\s*>` backtrack quadratically on a run
// of spaces with no closing `>`.
const TAG_RE = /<(\/?)\s*([A-Za-z_][\w.:-]{0,63})([^<>]*?)(\/?)>/g
const ATTR_RE = /([A-Za-z_][\w.:-]{0,127})\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function addWarning(warnings: TallyXmlRowWarning[], warning: TallyXmlRowWarning): void {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(warning)) warnings.push(warning)
}

function decodeEntities(raw: string, warnings: TallyXmlRowWarning[]): string {
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][\w.-]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : (addWarning(warnings, "UNKNOWN_ENTITY"), match)
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : (addWarning(warnings, "UNKNOWN_ENTITY"), match)
    }
    const named = NAMED_ENTITIES[body]
    if (named !== undefined) return named
    addWarning(warnings, "UNKNOWN_ENTITY")
    return match
  })
}

function parseAttributes(raw: string, warnings: TallyXmlRowWarning[]): Record<string, string> {
  const attrs: Record<string, string> = {}
  let match: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((match = ATTR_RE.exec(raw))) {
    const attrName = match[1]
    if (!attrName) continue
    const value = match[2] ?? match[3] ?? ""
    attrs[attrName.toUpperCase()] = decodeEntities(value, warnings).slice(0, MAX_TEXT)
  }
  if (raw.trim().length > 0 && Object.keys(attrs).length === 0) {
    addWarning(warnings, "MALFORMED_ATTRIBUTE")
  }
  return attrs
}

/** Reads a Tally date, accepting `YYYYMMDD` and `YYYY-MM-DD`. */
export function parseTallyRowDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const value = raw.trim()
  const match = DATE_RE.exec(value) ?? ISO_DATE_RE.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const asDate = new Date(Date.UTC(year, month - 1, day))
  if (
    Number.isNaN(asDate.getTime()) ||
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return undefined
  }
  return asDate.toISOString().slice(0, 10)
}

/** Parses a decimal amount into integer minor units (2 dp), rounding half up. */
function parseMinorUnits(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").replace(/\s+/g, "")
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(cleaned)
  if (!match) return null
  const whole = Number(match[2])
  if (!Number.isSafeInteger(whole)) return null
  const fraction = (match[3] ?? "").padEnd(3, "0")
  let minor = whole * 100 + Number(fraction.slice(0, 2))
  if (Number(fraction[2]) >= 5) minor += 1
  return match[1] === "-" ? -minor : minor
}

function minorToAmount(minor: number): number {
  return minor / 100
}

/** Parses a Tally amount, returning `undefined` rather than NaN. */
export function parseTallyAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const minor = parseMinorUnits(raw)
  return minor === null ? undefined : minorToAmount(minor)
}

/** Tally quantities and rates may be suffixed with a unit (`12 Strip`). */
function parseLeadingNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const match = /^[+-]?[\d,]+(?:\.\d+)?/.exec(raw.trim())
  if (!match) return undefined
  const cleaned = match[0].replace(/,/g, "")
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  const wanted = name.toUpperCase()
  return node.children.find((entry) => entry.name.toUpperCase() === wanted)
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  const wanted = name.toUpperCase()
  return node.children.filter((entry) => entry.name.toUpperCase() === wanted)
}

function textOf(node: XmlNode, name: string): string | undefined {
  const found = child(node, name)
  const value = found?.text.trim()
  return value ? value : undefined
}

function attrOf(node: XmlNode, name: string): string | undefined {
  const value = node.attrs[name.toUpperCase()]
  return value?.trim() ? value.trim() : undefined
}

function listText(node: XmlNode, listName: string, itemName: string): string | undefined {
  const list = child(node, listName)
  if (!list) return undefined
  const parts = childrenNamed(list, itemName)
    .map((entry) => entry.text.trim())
    .filter(Boolean)
  return parts.length ? parts.join(", ") : undefined
}

function readLedgerLine(node: XmlNode, warnings: TallyXmlRowWarning[]): TallyLedgerLine | undefined {
  const ledgerName = textOf(node, "LEDGERNAME") ?? attrOf(node, "LEDGERNAME")
  if (!ledgerName) return undefined

  const amountRaw = textOf(node, "AMOUNT")
  const amount = parseTallyAmount(amountRaw)
  if (amountRaw !== undefined && amount === undefined) addWarning(warnings, "AMOUNT_UNREADABLE")
  const magnitude = Math.abs(amount ?? 0)

  const deemedPositive = textOf(node, "ISDEEMEDPOSITIVE")?.toLowerCase()
  const side: "debit" | "credit" =
    deemedPositive === "yes" ? "debit" : deemedPositive === "no" ? "credit" : (amount ?? 0) < 0 ? "credit" : "debit"

  const bills = childrenNamed(node, "BILLALLOCATIONS.LIST").flatMap((bill) => {
    const name = textOf(bill, "NAME")
    const billAmount = parseTallyAmount(textOf(bill, "AMOUNT"))
    if (!name || billAmount === undefined) return []
    const creditPeriod = parseLeadingNumber(textOf(bill, "BILLCREDITPERIOD"))
    return [
      {
        name,
        billType: textOf(bill, "BILLTYPE"),
        amount: billAmount,
        creditPeriodDays: creditPeriod === undefined ? undefined : Math.trunc(creditPeriod),
      },
    ]
  })

  return {
    ledgerName,
    amount: magnitude,
    side,
    isParty: textOf(node, "ISPARTYLEDGER")?.toLowerCase() === "yes",
    narration: textOf(node, "NARRATION"),
    bills,
  }
}

function readBatch(node: XmlNode, warnings: TallyXmlRowWarning[]): TallyBatchAllocation {
  const quantityRaw = textOf(node, "ACTUALQTY") ?? textOf(node, "BILLEDQTY")
  const quantity = parseLeadingNumber(quantityRaw)
  if (quantityRaw !== undefined && quantity === undefined) addWarning(warnings, "QUANTITY_UNREADABLE")
  const expiryRaw = textOf(node, "EXPIRYDATE")
  return {
    batchName: textOf(node, "BATCHNAME"),
    expiryDate: expiryRaw ? parseTallyRowDate(expiryRaw) : undefined,
    quantity,
    amount: parseTallyAmount(textOf(node, "AMOUNT")),
    godown: textOf(node, "GODOWNNAME"),
  }
}

function readInventoryLine(node: XmlNode, warnings: TallyXmlRowWarning[]): TallyInventoryLine | undefined {
  const stockItemName =
    textOf(node, "STOCKITEMNAME") ?? textOf(node, "STOCKITEM") ?? attrOf(node, "STOCKITEMNAME")
  if (!stockItemName) return undefined

  const quantityRaw = textOf(node, "ACTUALQTY") ?? textOf(node, "BILLEDQTY")
  const quantity = parseLeadingNumber(quantityRaw)
  if (quantityRaw !== undefined && quantity === undefined) addWarning(warnings, "QUANTITY_UNREADABLE")

  const rateRaw = textOf(node, "RATE")
  const rate = parseLeadingNumber(rateRaw)
  const amount = parseTallyAmount(textOf(node, "AMOUNT")) ?? 0

  const ledgers = [
    ...childrenNamed(node, "LEDGERENTRIES.LIST"),
    ...childrenNamed(node, "ALLLEDGERENTRIES.LIST"),
    ...childrenNamed(node, "ACCOUNTINGALLOCATIONS.LIST").flatMap((allocation) => [
      ...childrenNamed(allocation, "LEDGERENTRIES.LIST"),
      ...childrenNamed(allocation, "ALLLEDGERENTRIES.LIST"),
    ]),
  ]
    .map((entry) => readLedgerLine(entry, warnings))
    .filter((entry): entry is TallyLedgerLine => entry !== undefined)

  return {
    stockItemName,
    quantity,
    unit: textOf(node, "UNIT") ?? textOf(node, "BASEUNITS"),
    rate,
    amount: Math.abs(amount),
    godown: textOf(node, "GODOWNNAME"),
    batches: childrenNamed(node, "BATCHALLOCATIONS.LIST").map((batch) => readBatch(batch, warnings)),
    ledgers,
  }
}

function readVoucher(node: XmlNode, warnings: TallyXmlRowWarning[]): TallyVoucher {
  const type =
    attrOf(node, "VCHTYPE") ??
    textOf(node, "VOUCHERTYPENAME") ??
    textOf(node, "VCHTYPE") ??
    "Unknown"
  const dateRaw = textOf(node, "DATE")
  const date = dateRaw ? parseTallyRowDate(dateRaw) : undefined
  if (dateRaw && !date) addWarning(warnings, "DATE_UNREADABLE")

  const ledgerLines = [
    ...childrenNamed(node, "LEDGERENTRIES.LIST"),
    ...childrenNamed(node, "ALLLEDGERENTRIES.LIST"),
  ]
    .map((entry) => readLedgerLine(entry, warnings))
    .filter((entry): entry is TallyLedgerLine => entry !== undefined)

  return {
    guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
    remoteId: textOf(node, "REMOTEID") ?? attrOf(node, "REMOTEID") ?? textOf(node, "MASTERID"),
    type,
    number: textOf(node, "VOUCHERNUMBER") ?? textOf(node, "VCHNO"),
    date,
    narration: textOf(node, "NARRATION"),
    partyLedgerName: textOf(node, "PARTYLEDGERNAME") ?? textOf(node, "PARTYNAME"),
    currency: textOf(node, "CURRENCYNAME"),
    isCancelled: (textOf(node, "ISCANCELLED") ?? "").toLowerCase() === "yes",
    ledgerLines,
    inventoryLines: [
      ...childrenNamed(node, "ALLINVENTORYENTRIES.LIST"),
      ...childrenNamed(node, "INVENTORYENTRIES.LIST"),
    ]
      .map((entry) => readInventoryLine(entry, warnings))
      .filter((entry): entry is TallyInventoryLine => entry !== undefined),
  }
}

function readGroup(node: XmlNode): TallyGroup {
  return {
    guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
    name: attrOf(node, "NAME") ?? textOf(node, "NAME") ?? "",
    parent: textOf(node, "PARENT"),
  }
}

function readLedger(node: XmlNode, warnings: TallyXmlRowWarning[]): TallyLedger {
  const openingRaw = textOf(node, "OPENINGBALANCE")
  const closingRaw = textOf(node, "CLOSEBALANCE")
  const openingBalance = parseTallyAmount(openingRaw)
  const closingBalance = parseTallyAmount(closingRaw)
  if (openingRaw !== undefined && openingBalance === undefined) addWarning(warnings, "AMOUNT_UNREADABLE")
  if (closingRaw !== undefined && closingBalance === undefined) addWarning(warnings, "AMOUNT_UNREADABLE")
  return {
    guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
    name: attrOf(node, "NAME") ?? textOf(node, "NAME") ?? "",
    parent: textOf(node, "PARENT"),
    openingBalance,
    closingBalance,
    isBillWise: (textOf(node, "ISBILLWISEON") ?? "").toLowerCase() === "yes",
    email: textOf(node, "EMAIL"),
    phone: textOf(node, "PHONE") ?? textOf(node, "MOBILE"),
    address: listText(node, "ADDRESS.LIST", "ADDRESS") ?? textOf(node, "ADDRESS"),
    bills: childrenNamed(node, "BILLALLOCATIONS.LIST").flatMap((bill) => {
      const name = textOf(bill, "NAME")
      const amount = parseTallyAmount(textOf(bill, "AMOUNT"))
      if (!name || amount === undefined) return []
      const creditPeriod = parseLeadingNumber(textOf(bill, "BILLCREDITPERIOD"))
      return [
        {
          name,
          billType: textOf(bill, "BILLTYPE"),
          amount,
          creditPeriodDays: creditPeriod === undefined ? undefined : Math.trunc(creditPeriod),
        },
      ]
    }),
  }
}

function readStockItem(node: XmlNode, warnings: TallyXmlRowWarning[]): TallyStockItem {
  const openingQuantityRaw = textOf(node, "OPENINGBALANCE")
  const openingQuantity = parseLeadingNumber(openingQuantityRaw)
  if (openingQuantityRaw !== undefined && openingQuantity === undefined) {
    addWarning(warnings, "QUANTITY_UNREADABLE")
  }
  return {
    guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
    name: attrOf(node, "NAME") ?? textOf(node, "NAME") ?? "",
    parent: textOf(node, "PARENT"),
    baseUnit: textOf(node, "BASEUNITS"),
    openingQuantity,
    openingRate: parseTallyAmount(textOf(node, "OPENINGRATE")),
    openingValue: parseTallyAmount(textOf(node, "OPENINGVALUE")),
    closingQuantity: parseLeadingNumber(textOf(node, "CLOSEBALANCE")),
    closingValue: parseTallyAmount(textOf(node, "CLOSINGVALUE")),
    batchWise: (textOf(node, "ISBATCHWISEON") ?? "").toLowerCase() === "yes",
    batches: childrenNamed(node, "BATCHALLOCATIONS.LIST").map((batch) => readBatch(batch, warnings)),
  }
}

function readCompany(node: XmlNode): {
  company?: string
  guid?: string
  currency?: string
  from?: string
  to?: string
} {
  return {
    company: textOf(node, "COMPANYNAME") ?? attrOf(node, "NAME"),
    guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
    currency: textOf(node, "CURRENCYNAME"),
    from: parseTallyRowDate(textOf(node, "SVFROMDATE")),
    to: parseTallyRowDate(textOf(node, "SVTODATE")),
  }
}

export function parseTallyXmlRows(input: Uint8Array | string, fileName = "tally.xml"): TallyXmlDocument {
  if (!fileName.trim() || /[\0\r\n]/.test(fileName)) throw new Error("MIGRATION_INVALID_FILENAME")
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  if (bytes.byteLength === 0) throw new Error("MIGRATION_EMPTY_FILE")
  if (bytes.byteLength > MAX_BYTES) throw new Error("MIGRATION_FILE_TOO_LARGE")

  let raw: string
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("MIGRATION_XML_NOT_UTF8")
  }

  const withoutComments = stripDelimited(raw, "<!--", "-->")
  if (/<!/.test(withoutComments)) throw new Error("MIGRATION_XML_ENTITIES_REJECTED")
  if (!withoutComments.includes("<")) throw new Error("MIGRATION_XML_MALFORMED")

  const tagCount = withoutComments.match(/<[A-Za-z/]/g)?.length ?? 0
  if (tagCount > MAX_TAGS) throw new Error("MIGRATION_XML_TOO_COMPLEX")

  const text = stripDelimited(withoutComments, "<?", "?>")
  const warnings: TallyXmlRowWarning[] = []
  const document: TallyXmlDocument = {
    financialPeriod: {},
    groups: [],
    ledgers: [],
    stockGroups: [],
    stockItems: [],
    units: [],
    godowns: [],
    vouchers: [],
    warnings,
  }

  let depth = 0
  let capturing = false
  let captureDepth = 0
  let captureNodes = 0
  const nodeStack: XmlNode[] = []

  const finishRecord = (node: XmlNode) => {
    const name = node.name.toUpperCase()
    if (name === "VOUCHER") document.vouchers.push(readVoucher(node, warnings))
    else if (name === "LEDGER") document.ledgers.push(readLedger(node, warnings))
    else if (name === "GROUP") document.groups.push(readGroup(node))
    else if (name === "STOCKITEM") document.stockItems.push(readStockItem(node, warnings))
    else if (name === "STOCKGROUP") {
      document.stockGroups.push({
        guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
        name: attrOf(node, "NAME") ?? textOf(node, "NAME") ?? "",
        parent: textOf(node, "PARENT"),
      })
    } else if (name === "UNIT") {
      document.units.push({
        guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
        name: attrOf(node, "NAME") ?? textOf(node, "NAME") ?? "",
        symbol: textOf(node, "SYMBOL"),
      })
    } else if (name === "GODOWN") {
      document.godowns.push({
        guid: textOf(node, "GUID") ?? attrOf(node, "GUID"),
        name: attrOf(node, "NAME") ?? textOf(node, "NAME") ?? "",
        parent: textOf(node, "PARENT"),
      })
    } else if (name === "COMPANY") {
      const company = readCompany(node)
      if (company.company) document.company = company.company
      if (company.guid) document.companyGuid = company.guid
      if (company.currency) document.currency = company.currency
      if (company.from) document.financialPeriod.from = company.from
      if (company.to) document.financialPeriod.to = company.to
    }
  }

  const recordCount = () =>
    document.vouchers.length +
    document.ledgers.length +
    document.groups.length +
    document.stockItems.length +
    document.stockGroups.length +
    document.units.length +
    document.godowns.length

  let lastIndex = 0
  let match: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(text))) {
    const gap = text.slice(lastIndex, match.index)
    if (capturing && gap.trim()) {
      const current = nodeStack[nodeStack.length - 1]
      if (current && current.text.length < MAX_TEXT) {
        current.text += decodeEntities(gap, warnings).slice(0, MAX_TEXT - current.text.length)
      }
    }
    lastIndex = TAG_RE.lastIndex

    const closing = match[1] === "/"
    const name = match[2] ?? ""
    const selfClosing = match[4] === "/"
    const upper = name.toUpperCase()

    if (closing) {
      depth = Math.max(0, depth - 1)
      if (capturing) {
        const node = nodeStack.pop()
        if (!node || node.name.toUpperCase() !== upper) addWarning(warnings, "UNEXPECTED_CLOSE")
        if (nodeStack.length === 0) {
          if (node) finishRecord(node)
          capturing = false
        }
      }
      continue
    }

    if (!capturing && RECORD_ELEMENTS.has(upper)) {
      if (recordCount() >= MAX_RECORDS) {
        addWarning(warnings, "RECORD_LIMIT_REACHED")
        capturing = false
        depth++
        continue
      }
      capturing = true
      captureDepth = depth
      captureNodes = 0
      nodeStack.length = 0
    }

    if (capturing) {
      if (++captureNodes > MAX_RECORD_NODES) {
        addWarning(warnings, "RECORD_NODE_LIMIT")
        capturing = false
        nodeStack.length = 0
        depth++
        continue
      }
      const node: XmlNode = {
        name,
        attrs: parseAttributes(match[3] ?? "", warnings),
        text: "",
        children: [],
      }
      const parent = nodeStack[nodeStack.length - 1]
      if (parent) parent.children.push(node)
      nodeStack.push(node)

      const closesRecord = selfClosing && depth === captureDepth
      if (selfClosing) {
        nodeStack.pop()
        if (closesRecord) {
          finishRecord(node)
          capturing = false
        }
      }
    }

    depth++
  }

  if (capturing) addWarning(warnings, "UNCLOSED_RECORD")

  return document
}

/** Exposed so tests and the upload gate state the bound once. */
export const TALLY_XML_ROW_LIMITS = {
  MAX_BYTES,
  MAX_TAGS,
  MAX_RECORDS,
  MAX_RECORD_NODES,
  MAX_TEXT,
  MAX_WARNINGS,
} as const
