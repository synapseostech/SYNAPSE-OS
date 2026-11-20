/**
 * Code 128 (subset B) barcodes for specimen labels, as inline SVG.
 * No dependency: label printers and phone scanners read Code 128 natively, and
 * accession numbers (FAC-YYYYMMDD-000123) are printable ASCII.
 */

// Bar/space widths for symbol values 0..106 (106 = stop, which has 7 elements).
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
]

const START_B = 104
const STOP = 106

export class Code128Error extends Error {}

/** Symbol values including start, checksum and stop. */
export function code128BValues(text: string): number[] {
  if (!text) throw new Code128Error("CODE128_EMPTY")
  if (text.length > 48) throw new Code128Error("CODE128_TOO_LONG")
  const values = [START_B]
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code > 126) throw new Code128Error("CODE128_UNSUPPORTED_CHARACTER")
    values.push(code - 32)
  }
  let checksum = START_B
  values.forEach((value, i) => { if (i > 0) checksum += value * i })
  values.push(checksum % 103, STOP)
  return values
}

/** Module widths, alternating bar/space, starting with a bar. */
export function code128Modules(text: string): number[] {
  return code128BValues(text).flatMap((value) => (PATTERNS[value] ?? "").split("").map(Number))
}

export function code128Svg(text: string, options: { height?: number; moduleWidth?: number; quiet?: number } = {}): string {
  const height = options.height ?? 48
  const unit = options.moduleWidth ?? 2
  const quiet = (options.quiet ?? 10) * unit
  const modules = code128Modules(text)
  let x = quiet
  const rects: string[] = []
  modules.forEach((width, index) => {
    if (index % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${width * unit}" height="${height}"/>`)
    x += width * unit
  })
  const total = x + quiet
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" width="${total}" height="${height}" role="img" aria-label="Barcode ${text.replace(/[<>&"']/g, "")}" shape-rendering="crispEdges"><rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`
}
