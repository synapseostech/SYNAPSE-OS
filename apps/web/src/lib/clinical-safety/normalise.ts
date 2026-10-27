/**
 * Drug-name normalisation.
 *
 * The prescription record stores a free-text `medication_display` and the
 * pharmacy product carries `name`, `generic_name` and `active_ingredient` —
 * none of them a code. So matching against a catalogue of names is the only
 * thing available today, and it has to be conservative: a false positive costs
 * a clinician a dismissal click, a false negative costs a patient an interaction.
 * Neither is acceptable, so the matcher only fires on token boundaries and
 * reports its own strength.
 *
 * Known limitation, deliberately not papered over: synonyms across markets
 * (paracetamol / acetaminophen, salbutamol / albuterol) do not match without a
 * dictionary, and no dictionary exists in this tree. That is why the evaluation
 * result carries a coverage state — a miss on an empty catalogue and a miss on a
 * populated one must not read the same.
 */

/** Dosage forms, strengths and routes carry no identity and are stripped. */
const NOISE_TOKENS = new Set([
  'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps',
  'syrup', 'suspension', 'soln', 'solution', 'injection', 'inj', 'infusion',
  'cream', 'ointment', 'drops', 'drop', 'inhaler', 'spray', 'patch', 'gel',
  'suppository', 'vial', 'ampoule', 'amp', 'sachet', 'powder', 'granules',
  'oral', 'topical', 'ophthalmic', 'otic', 'nasal', 'rectal', 'vaginal',
  'iv', 'im', 'sc', 'sr', 'xr', 'er', 'cr', 'mr', 'xl', 'ds', 'forte', 'plain',
  'and', 'plus', 'with',
  // Units are stripped as whole tokens too, not only when attached to a number:
  // "250 mg / 5 ml" leaves `mg` and `ml` behind once the numerals go.
  'mg', 'mcg', 'ug', 'g', 'kg', 'ml', 'l', 'iu', 'u', 'mmol', 'meq', 'per',
])

/** `500`, `500mg`, `0.5`, `5%` — strengths, never identity. */
const STRENGTH = /^\d+(?:[.,]\d+)?(?:mg|mcg|ug|g|kg|ml|l|iu|u|mmol|meq|%)?$/

/**
 * Lower-case, strip punctuation, drop strengths and dosage forms, and return
 * the identity tokens. `"Paracetamol 500mg tablets"` → `["paracetamol"]`.
 */
export function normaliseName(raw: string | null | undefined): string[] {
  if (!raw) return []
  const flat = raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!flat) return []
  const tokens: string[] = []
  for (const token of flat.split(/\s+/)) {
    if (!token || NOISE_TOKENS.has(token) || STRENGTH.test(token)) continue
    tokens.push(token)
  }
  return tokens
}

export function normalisedKey(raw: string | null | undefined): string {
  return normaliseName(raw).join(' ')
}

export type MatchStrength = 'exact' | 'token' | 'none'

/**
 * Minimum length for a catalogue name to be allowed to match at all. Below this
 * the token subsequence rule starts matching things like "asa" inside unrelated
 * words, and a safety system that cries wolf is a safety system that gets turned
 * off.
 */
const MIN_MATCHABLE_LENGTH = 4

/**
 * Compare one candidate string against one catalogue name.
 *
 * `exact`  — same identity tokens, in the same order.
 * `token`  — the catalogue name appears as a contiguous run of whole tokens
 *            inside the candidate (`"paracetamol"` in `"paracetamol actavis"`).
 * `none`   — no whole-token match. Substring matches that cross a token
 *            boundary are rejected on purpose: `"penicillin"` must not match
 *            `"penicillamine"`.
 */
export function matchDrugName(candidate: string | null | undefined, catalogueName: string | null | undefined): MatchStrength {
  const want = normaliseName(catalogueName)
  const have = normaliseName(candidate)
  if (want.length === 0 || have.length === 0) return 'none'
  const wantKey = want.join(' ')
  if (wantKey.length < MIN_MATCHABLE_LENGTH) return 'none'

  if (wantKey === have.join(' ')) return 'exact'

  if (want.length > have.length) return 'none'
  for (let start = 0; start + want.length <= have.length; start += 1) {
    let hit = true
    for (let offset = 0; offset < want.length; offset += 1) {
      if (have[start + offset] !== want[offset]) {
        hit = false
        break
      }
    }
    if (hit) return 'token'
  }
  return 'none'
}

/** True when any supplied name matches the catalogue name. */
export function matchesAnyName(names: Array<string | null | undefined>, catalogueName: string | null | undefined): MatchStrength {
  let best: MatchStrength = 'none'
  for (const name of names) {
    const strength = matchDrugName(name, catalogueName)
    if (strength === 'exact') return 'exact'
    if (strength === 'token') best = 'token'
  }
  return best
}

/**
 * ATC matching. The hierarchy is prefix-based — `N02BE01` sits under `N02BE`,
 * under `N02B`, under `N02`. A patient-recorded allergy to `N02` therefore
 * applies to `N02BE01`. Both sides are upper-cased and stripped of separators.
 */
export function matchesAtcPrefix(candidateAtc: string | null | undefined, allergyAtc: string | null | undefined): boolean {
  const a = (candidateAtc ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const b = (allergyAtc ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (a.length < 3 || b.length < 3) return false
  return a.startsWith(b) || b.startsWith(a)
}

/** Normalised ICD-11 stem code: `"5A11.0"` → `"5a11.0"`. */
export function normaliseIcd(code: string | null | undefined): string {
  return (code ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * ICD-11 stem codes are hierarchical: `5A11.0` is a child of `5A11`. A
 * contraindication recorded against the parent applies to the child.
 */
export function matchesIcd(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normaliseIcd(a)
  const right = normaliseIcd(b)
  if (left.length < 3 || right.length < 3) return false
  if (left === right) return true
  return left.startsWith(`${right}.`) || right.startsWith(`${left}.`)
}
