import Papa from "papaparse"

export function formatImportRows(rows: string[][]): string {
  return Papa.unparse(rows.map((row) => row.map((cell) => String(cell ?? ""))))
}

export function parseImportRows(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: true,
  })

  if (parsed.errors.length > 0) {
    throw new Error("Import rows contain invalid CSV quoting. Check cells with commas or line breaks.")
  }

  return parsed.data.map((row) => row.map((cell) => String(cell ?? "")))
}
