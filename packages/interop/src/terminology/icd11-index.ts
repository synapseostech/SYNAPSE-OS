/**
 * Full WHO ICD-11 MMS index (server only: about 1.3 MB of data).
 *
 * Import through `@synapse/interop/icd11-index`, never from the package root,
 * so client bundles stay small. Every code and title here is WHO's own
 * (see scripts/icd11/build-index.mjs). Nothing is invented: a stem is accepted
 * only when it is in this index.
 */
import { ICD11_MMS_DATA_COUNT, ICD11_MMS_DATA_RELEASE, ICD11_MMS_TSV } from "./icd11-mms-data"
import { ICD11_API_BASE, ICD11_CLASSIFICATION, ICD11_RELEASE, type Icd11Entity, type Icd11SearchHit } from "./icd11"

export type Icd11IndexEntry = Icd11Entity & {
  parentCode: string | null
  isLeaf: boolean
  isResidual: boolean
  chapter: string
}

type Indexed = Icd11IndexEntry & { norm: string; words: string[] }

let cache: { byCode: Map<string, Indexed>; all: Indexed[] } | null = null

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
}

function load() {
  if (cache) return cache
  if (ICD11_MMS_DATA_RELEASE !== ICD11_RELEASE) {
    throw new Error(`ICD11_RELEASE_MISMATCH data=${ICD11_MMS_DATA_RELEASE} code=${ICD11_RELEASE}`)
  }
  const all: Indexed[] = []
  const byCode = new Map<string, Indexed>()
  for (const line of ICD11_MMS_TSV.split("\n")) {
    const [code, title, foundationId = "", parentCode = "", flags = "", chapter = ""] = line.split("\t")
    if (!code || !title) continue
    const norm = normalize(title)
    const entry: Indexed = {
      stemCode: code,
      title,
      foundationUri: `http://id.who.int/icd/entity/${foundationId}`,
      linearizationUri: `${ICD11_API_BASE}/${foundationId}`,
      classification: ICD11_CLASSIFICATION,
      release: ICD11_RELEASE,
      parentCode: parentCode || null,
      isLeaf: flags.includes("L"),
      isResidual: flags.includes("R"),
      chapter,
      norm,
      words: norm.split(" "),
    }
    all.push(entry)
    byCode.set(code.toUpperCase(), entry)
  }
  if (all.length !== ICD11_MMS_DATA_COUNT) throw new Error("ICD11_INDEX_TRUNCATED")
  cache = { byCode, all }
  return cache
}

function publicEntry(e: Indexed): Icd11IndexEntry {
  const { norm: _n, words: _w, ...rest } = e
  return rest
}

export function icd11IndexSize(): number {
  return load().all.length
}

/** The WHO entry for a stem code, or null. Case-insensitive. */
export function lookupIcd11Code(code: string): Icd11IndexEntry | null {
  const hit = load().byCode.get(String(code ?? "").trim().toUpperCase())
  return hit ? publicEntry(hit) : null
}

export function isIcd11Code(code: string): boolean {
  return lookupIcd11Code(code) != null
}

/**
 * Clinical shorthand used on Ugandan wards, mapped to WHO codes. Each target is
 * checked against the index by the test suite, so a typo fails CI.
 */
export const ICD11_SHORTHAND: Record<string, string[]> = {
  uti: ["GC08", "GC00", "GB51"],
  urti: ["CA07.0", "CA02", "CA03"],
  lrti: ["CA40.Z", "CA42.Z"],
  rti: ["CA07.0", "CA40.Z"],
  pud: ["DA61", "DA42"],
  gerd: ["DA22"],
  gord: ["DA22"],
  htn: ["BA00"],
  hypertension: ["BA00"],
  dm: ["5A11", "5A10"],
  t2dm: ["5A11"],
  t1dm: ["5A10"],
  dka: ["5A22.0"],
  ptb: ["1B10"],
  tb: ["1B10", "1B12"],
  hiv: ["1C62", "1C60", "1C61"],
  age: ["1A40.Z", "ME05.1"],
  gastro: ["1A40.Z"],
  pid: ["GA05"],
  ccf: ["BD10"],
  chf: ["BD10"],
  scd: ["3A51.1", "3A51.2"],
  ida: ["3A00"],
  bs: ["1F4Z", "1F40"],
  mps: ["1F4Z", "1F40"],
  "simple malaria": ["1F40", "1F4Z"],
  "severe malaria": ["1F40", "1F4Z"],
  pet: ["JA24"],
  aom: ["AB00"],
  ssti: ["1B70"],
}

/**
 * Search the index. Ranking: exact code, then code prefix, then shorthand,
 * then title words in order; leaves before groups, specific before
 * "unspecified" residuals.
 */
export function searchIcd11Index(query: string, limit = 20): Icd11SearchHit[] {
  const q = String(query ?? "").slice(0, 120)
  const needle = normalize(q)
  if (!needle) return []
  const { byCode, all } = load()
  const scored = new Map<string, { e: Indexed; score: number }>()
  const put = (e: Indexed, score: number) => {
    const prev = scored.get(e.stemCode)
    if (!prev || prev.score < score) scored.set(e.stemCode, { e, score })
  }

  const upper = q.trim().toUpperCase()
  const exact = byCode.get(upper)
  if (exact) put(exact, 1)
  if (/^[0-9A-Z]{2,}[0-9A-Z.]*$/.test(upper)) {
    for (const e of all) if (e.stemCode.startsWith(upper) && e.stemCode !== upper) put(e, 0.9 - e.stemCode.length * 0.005)
  }

  for (const [i, target] of (ICD11_SHORTHAND[needle] ?? []).entries()) {
    const e = byCode.get(target.toUpperCase())
    if (e) put(e, 0.88 - i * 0.001)
  }

  const parts = needle.split(" ").filter((p) => p.length > 0)
  for (const e of all) {
    if (e.norm === needle) {
      put(e, 0.86)
      continue
    }
    let matched = 0
    let prefixHits = 0
    for (const p of parts) {
      if (e.words.some((w) => w.startsWith(p))) {
        matched += 1
        if ((e.words[0] ?? "").startsWith(p)) prefixHits += 1
      }
    }
    if (matched === parts.length) {
      let score = 0.5 + (e.norm.startsWith(needle) ? 0.25 : 0) + prefixHits * 0.03
      score -= Math.min(e.words.length, 20) * 0.006
      if (e.isResidual) score -= 0.02
      if (!e.isLeaf) score += 0.01
      put(e, Math.min(score, 0.85))
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.e.stemCode.localeCompare(b.e.stemCode))
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map(({ e, score }) => ({ ...publicEntry(e), score: Math.round(score * 1000) / 1000 }))
}
