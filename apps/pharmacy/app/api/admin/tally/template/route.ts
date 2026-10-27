import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { TALLY_SHEETS } from "@/lib/tally/workbook"

/**
 * GET /api/admin/tally/template[?format=csv]
 * Downloads the normalised import template. Header-only apart from a Meta
 * sheet and one clearly-labelled example voucher, so no catalogue is invented.
 */

const META_ROWS = [
  ["company", "Example Pharmacy Ltd"],
  ["conversion_date", "2026-04-01"],
  ["currency", "UGX"],
]

const EXAMPLE_ROWS: Partial<Record<string, string[][]>> = {
  Accounts: [
    ["Example Bank Account", "Bank Accounts"],
    ["Example Capital Account", "Capital Account"],
    ["Example Cash-in-Hand", "Cash-in-Hand"],
  ],
  Vouchers: [["EXAMPLE-1", "Journal", "2026-04-01", "", "EXAMPLE-1", "", "Opening capital example"]],
  VoucherLines: [
    ["EXAMPLE-1", "Example Bank Account", "1000000", "", "", ""],
    ["EXAMPLE-1", "Example Capital Account", "", "1000000", "", ""],
  ],
}

const CSV_COLUMNS: Record<string, string[]> = {
  meta: ["key", "value"],
  account: ["name", "parent", "guid", "opening_balance", "closing_balance", "email", "phone", "address"],
  stock_item: ["name", "guid", "parent", "unit", "opening_quantity", "opening_rate", "opening_value"],
  stock_batch: ["stock_item", "batch", "expiry", "quantity", "amount", "godown"],
  voucher: ["id", "type", "date", "guid", "number", "party", "narration", "currency", "cancelled"],
  voucher_line: ["voucher_id", "ledger", "debit", "credit", "narration", "party"],
  stock_line: ["voucher_id", "stock_item", "quantity", "unit", "rate", "amount", "godown", "batch", "expiry", "account_ledger"],
  bill: ["ledger", "name", "amount", "bill_type", "credit_days"],
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function buildCsv(): string {
  const recordTypes = Object.keys(CSV_COLUMNS)
  const header = ["record_type", ...new Set(recordTypes.flatMap((type) => CSV_COLUMNS[type]!))]
  const lines = [header.map(csvCell).join(",")]

  // One union header covers every record type, so each row is placed by column
  // name — positioning a bare array here would land values in the wrong fields.
  const rows: Array<Record<string, string>> = [
    ...META_ROWS.map(([key, value]) => ({ record_type: "meta", key, value })),
    { record_type: "account", name: "Example Bank Account", parent: "Bank Accounts" },
    { record_type: "account", name: "Example Capital Account", parent: "Capital Account" },
    { record_type: "account", name: "Example Cash-in-Hand", parent: "Cash-in-Hand" },
    // The example voucher keeps the CSV and XLSX templates telling the same story.
    {
      record_type: "voucher",
      id: "EXAMPLE-1",
      type: "Journal",
      date: "2026-04-01",
      number: "EXAMPLE-1",
      narration: "Opening capital example",
    },
    {
      record_type: "voucher_line",
      voucher_id: "EXAMPLE-1",
      ledger: "Example Bank Account",
      debit: "1000000",
    },
    {
      record_type: "voucher_line",
      voucher_id: "EXAMPLE-1",
      ledger: "Example Capital Account",
      credit: "1000000",
    },
  ]

  for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column] ?? "")).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}

function buildWorkbook(): ArrayBuffer {
  const workbook = XLSX.utils.book_new()

  const meta = XLSX.utils.aoa_to_sheet([["key", "value"], ...META_ROWS])
  XLSX.utils.book_append_sheet(workbook, meta, "Meta")

  for (const spec of TALLY_SHEETS) {
    if (spec.sheet === "Meta") continue
    const header = spec.columns.map((column) => column.name)
    const rows = EXAMPLE_ROWS[spec.sheet] ?? []
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ...rows]), spec.sheet)
  }

  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer
}

export async function GET(request: NextRequest) {
  const auth = await requirePharmacyPermission("inventory.write")
  if (!auth.ok) return auth.response

  const wantsCsv = request.nextUrl.searchParams.get("format") === "csv"

  if (wantsCsv) {
    return new NextResponse(buildCsv(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="tally-import-template.csv"',
        "Cache-Control": "no-store",
      },
    })
  }

  return new NextResponse(buildWorkbook(), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="tally-import-template.xlsx"',
      "Cache-Control": "no-store",
    },
  })
}
