/** A date range an export's own file name states. */
export type FileNamePeriod = { from: string; to: string }

export const isIsoDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value

/**
 * The range an export names in its own file name, as the Synapse export
 * script writes it (`3-daybook-20250101-20251231.xml`). Slices have to carry
 * their own dates: one period typed into the form would make every slice claim
 * the whole migration and collide with the others.
 */
export function periodFromFileName(name: string): FileNamePeriod | undefined {
  const match = /(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})\.xml$/i.exec(name)
  if (match) {
    const from = `${match[1]}-${match[2]}-${match[3]}`
    const to = `${match[4]}-${match[5]}-${match[6]}`
    if (!isIsoDay(from) || !isIsoDay(to) || to < from) return undefined
    return { from, to }
  }

  // Tally's own month export is named after the month it covers
  // (`2025-10-full.xml`). The calendar month is the range, not the span of the
  // vouchers in it: consecutive spans leave the quiet days between them as gaps
  // the manifest refuses.
  const month = /(?:^|\D)(\d{4})-(\d{2})(?:-(?:full|month))?\.xml$/i.exec(name)
  if (!month) return undefined
  const year = Number(month[1])
  const monthNumber = Number(month[2])
  const from = `${month[1]}-${month[2]}-01`
  if (monthNumber < 1 || monthNumber > 12 || !isIsoDay(from)) return undefined
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return { from, to: `${month[1]}-${month[2]}-${String(lastDay).padStart(2, "0")}` }
}

/**
 * The part of the cut-over a file holds, when its name says so. A name that
 * says nothing (`2025-10-full.xml`) is left unclassified on purpose: the server
 * reads the file and decides from what it actually contains.
 */
export function kindFromFileName(name: string): "masters" | "vouchers" | undefined {
  const lower = name.toLowerCase()
  if (lower.includes("masters")) return "masters"
  if (lower.includes("daybook") || lower.includes("day-book")) return "vouchers"
  return undefined
}
