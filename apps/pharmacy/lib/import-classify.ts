export type ImportTarget = "tally" | "assistant"

export type ImportClassification =
  | { target: ImportTarget; files: string[] }
  | { target: null; error: string; files: string[] }

const TALLY_EXTENSIONS = ["xml", "zip"]
const ASSISTANT_EXTENSIONS = ["csv", "xlsx", "xls", "json"]

function extensionOf(name: string): string {
  const trimmed = name.trim().toLowerCase()
  const dot = trimmed.lastIndexOf(".")
  return dot > 0 ? trimmed.slice(dot + 1) : ""
}

/**
 * Which workspace a chosen set of files belongs to, read from their names.
 *
 * A Tally export is XML, zipped or not, and opens the cut-over. A workbook, a
 * CSV or a JSON file is a stock file for the assistant. The two are never
 * read as one import: a cut-over and a stock receipt post different things,
 * so a mixed selection is refused and named rather than guessed at.
 */
export function classifyImportFiles(names: string[]): ImportClassification {
  const files = names.map((name) => name.trim()).filter(Boolean)
  if (files.length === 0) {
    return { target: null, error: "Choose a file to import.", files }
  }

  const unknown = files.filter((name) => {
    const extension = extensionOf(name)
    return !TALLY_EXTENSIONS.includes(extension) && !ASSISTANT_EXTENSIONS.includes(extension)
  })
  if (unknown.length > 0) {
    return {
      target: null,
      error: `Cannot tell what ${unknown.length === 1 ? "this file is" : "these files are"}: ${unknown.join(", ")}. Expected a Tally export (.xml or .zip) or a stock file (.csv, .xlsx, .xls or .json).`,
      files: unknown,
    }
  }

  const tally = files.filter((name) => TALLY_EXTENSIONS.includes(extensionOf(name)))
  if (tally.length > 0 && tally.length < files.length) {
    return {
      target: null,
      error:
        "A Tally cut-over and a stock file cannot be imported together. Import the Tally export on its own, then the stock file separately.",
      files,
    }
  }

  return { target: tally.length > 0 ? "tally" : "assistant", files }
}
