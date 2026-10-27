import { createHash } from 'node:crypto'

/**
 * Maps a raw imported patient record onto the columns that actually exist on
 * `public.patients`.
 *
 * Two rules that matter for safety:
 *  1. `mrn` is NOT NULL in the schema and is the facility's medical record
 *     number. It is never generated here — an import without an MRN is
 *     reported as an error so a human can supply it. Inventing one would
 *     create a patient record that no facility could ever reconcile.
 *  2. `dob` is the real column name. The previous importer wrote
 *     `date_of_birth`, which does not exist, so every row failed.
 */

export type MappedPatient = {
  full_name: string
  mrn: string
  dob: string | null
  sex: string | null
  phone: string | null
  nin: string | null
  village: string | null
  district: string | null
}

export type MapResult =
  | { ok: true; value: MappedPatient; warnings: string[] }
  | { ok: false; errors: string[] }

const NAME_KEYS = ['full_name', 'full name', 'patient_name', 'patient name', 'name']
const MRN_KEYS = ['mrn', 'medical_record_number', 'medical record number', 'hospital_number', 'patient_number']
const DOB_KEYS = ['dob', 'date_of_birth', 'date of birth', 'birth_date', 'birthdate']
const SEX_KEYS = ['sex', 'gender']
const PHONE_KEYS = ['phone', 'phone_number', 'telephone', 'mobile']
const NIN_KEYS = ['nin', 'national_id', 'national id']
const VILLAGE_KEYS = ['village', 'parish']
const DISTRICT_KEYS = ['district']

/** Normalise header/record keys: trim, lower-case, collapse whitespace and underscores. */
function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

function indexRecord(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[normaliseKey(key)] = String(value ?? '').trim()
  }
  return out
}

function pick(index: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = index[normaliseKey(key)]
    if (value) return value
  }
  return null
}

const SEX_MAP: Record<string, string> = {
  m: 'male',
  male: 'male',
  f: 'female',
  female: 'female',
  o: 'other',
  other: 'other',
  unknown: 'unknown',
}

/** Accepts ISO (`YYYY-MM-DD`), `DD/MM/YYYY` and `YYYY/MM/DD`. Returns ISO or null. */
export function normaliseDob(value: string | null): { iso: string | null; error?: string } {
  if (!value) return { iso: null }
  const trimmed = value.trim()
  if (!trimmed) return { iso: null }

  let y: number | null = null
  let m: number | null = null
  let d: number | null = null

  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(trimmed)
  if (match) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3])
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed)
    if (match) {
      // Day-first is the convention in Uganda; a value >12 in the first slot can only be a day.
      d = Number(match[1]); m = Number(match[2]); y = Number(match[3])
    }
  }

  if (y == null || m == null || d == null) return { iso: null, error: `Unparseable date of birth: "${trimmed}"` }
  if (m < 1 || m > 12 || d < 1 || d > 31) return { iso: null, error: `Invalid date of birth: "${trimmed}"` }

  const date = new Date(Date.UTC(y, m - 1, d))
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { iso: null, error: `Invalid date of birth: "${trimmed}"` }
  }
  if (date.getTime() > Date.now()) return { iso: null, error: `Date of birth is in the future: "${trimmed}"` }

  return { iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
}

export function mapPatientRow(raw: Record<string, string>): MapResult {
  const index = indexRecord(raw)
  const errors: string[] = []
  const warnings: string[] = []

  const fullName = pick(index, NAME_KEYS)
  if (!fullName) errors.push('Missing full name')
  else if (fullName.length > 200) errors.push('Full name exceeds 200 characters')

  const mrn = pick(index, MRN_KEYS)
  if (!mrn) errors.push('Missing MRN (medical record number). MRNs are never generated during import.')
  else if (mrn.length > 64) errors.push('MRN exceeds 64 characters')

  const dobRaw = pick(index, DOB_KEYS)
  const dobResult = normaliseDob(dobRaw)
  if (dobResult.error) errors.push(dobResult.error)

  const sexRaw = pick(index, SEX_KEYS)
  let sex: string | null = null
  if (sexRaw) {
    sex = SEX_MAP[sexRaw.toLowerCase()] ?? null
    if (!sex) warnings.push(`Unrecognised sex value "${sexRaw}" — stored as NULL`)
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    warnings,
    value: {
      full_name: fullName as string,
      mrn: mrn as string,
      dob: dobResult.iso,
      sex,
      phone: pick(index, PHONE_KEYS),
      nin: pick(index, NIN_KEYS),
      village: pick(index, VILLAGE_KEYS),
      district: pick(index, DISTRICT_KEYS),
    },
  }
}

/**
 * Stable dedupe key for a source row.
 *
 * Re-uploading the same file (or retrying an execute) must not create a second
 * batch row for the same patient. Keyed on the normalised source content, not
 * on row number, so inserted blank lines do not create duplicates.
 */
export function dedupeKeyFor(raw: Record<string, string>): string {
  const index = indexRecord(raw)
  const canonical = Object.keys(index)
    .sort()
    .map((key) => `${key}=${index[key]}`)
    .join('&')
  return createHash('sha256').update(canonical).digest('hex')
}
