/**
 * Deterministic safety layer for the My Health AI companion.
 *
 * These checks run before and after the model, and never depend on it:
 *  - red flags short-circuit to an emergency message (no model call, no quota)
 *  - requests to change a dose are refused without asking the model
 *  - model output that prescribes a dose or asserts a diagnosis is replaced
 *
 * The Luganda and Swahili phrases are a starting set and should be reviewed by
 * native-speaking clinicians before they are relied on.
 */

export type CompanionLanguage = "en" | "lg" | "sw"
export const COMPANION_LANGUAGES: CompanionLanguage[] = ["en", "lg", "sw"]

export type RedFlagCategory =
  | "cardiac"
  | "breathing"
  | "stroke"
  | "collapse_seizure"
  | "severe_bleeding"
  | "self_harm"
  | "pregnancy"
  | "child_danger"
  | "poisoning"
  | "anaphylaxis"
  | "meningitis"
  | "snake_bite"
  | "severe_burn"

type Rule = { category: RedFlagCategory; pattern: RegExp }

const RED_FLAG_RULES: Rule[] = [
  // English
  { category: "cardiac", pattern: /\bchest\s+(pain|pressure|tightness|hurts?|heaviness)\b|\bpain\s+in\s+(my\s+)?chest\b|\bheart\s+attack\b/i },
  { category: "breathing", pattern: /\b(can'?t|cannot|can not|unable to|struggling to|hard to|difficult(y)? (to )?)\s*breath(e|ing)?\b|\bshort(ness)? of breath\b|\bchoking\b|\blips? (are |is )?(turning )?(blue|grey|gray)\b/i },
  { category: "stroke", pattern: /\b(face|mouth) (is )?(drooping|droops|twisted)\b|\bslurred speech\b|\bsudden(ly)? (weak|numb|can'?t (move|speak|see))|\bweak(ness)? on one side\b|\b(having|had|is having) a stroke\b/i },
  { category: "collapse_seizure", pattern: /\b(unconscious|passed out|fainted|collapsed|not waking up|won'?t wake up|unresponsive)\b|\b(seizure|seizures|convuls\w*|fitting)\b/i },
  { category: "severe_bleeding", pattern: /\b(heavy|severe|a lot of|won'?t stop|can'?t stop|non-?stop)\s+bleed\w*|\bbleeding (heavily|a lot|won'?t stop)\b|\b(vomit\w*|cough\w*) (up )?blood\b|\bblack,? tarry stool\b/i },
  { category: "self_harm", pattern: /\b(kill|hurt|harm) (myself|me)\b|\bsuicid\w*\b|\bend (my|it all|my life)\b|\bwant to die\b|\bdon'?t want to (live|be alive)\b|\boverdose on purpose\b/i },
  { category: "pregnancy", pattern: /\bpregnan\w*\b[^.?!]{0,60}\b(bleed\w*|severe headache|blurred vision|fits?|convuls\w*|water broke|severe (pain|cramps?))\b|\bbaby (is )?(not|stopped) (moving|kicking)\b/i },
  { category: "child_danger", pattern: /\b(baby|child|infant|newborn|toddler)\b[^.?!]{0,60}\b(can'?t|cannot|unable to|not|won'?t|refus\w*)\s+(drink|breast ?feed|feed|suck|wake)\b|\b(baby|infant|newborn)\b[^.?!]{0,40}\b(very sleepy|floppy|fever|hot)\b/i },
  { category: "poisoning", pattern: /\b(swallowed|drank|ate|took)\b[^.?!]{0,40}\b(poison|bleach|paraffin|pesticide|rat poison|too many (pills|tablets))\b|\boverdos\w*\b|\bpoison(ed|ing)\b/i },
  { category: "anaphylaxis", pattern: /\b(throat|tongue|lips?|face) (is |are )?(swelling|swollen|closing)\b|\banaphyla\w*\b/i },
  { category: "meningitis", pattern: /\bstiff neck\b[^.?!]{0,40}\bfever\b|\bfever\b[^.?!]{0,40}\bstiff neck\b/i },
  { category: "snake_bite", pattern: /\b(snake|snakebite)\b[^.?!]{0,20}\b(bite|bit|bitten)\b|\bbitten by a snake\b/i },
  { category: "severe_burn", pattern: /\b(severe|bad|large|big) burns?\b|\bburnt? (my|his|her|the)? ?(face|whole|body)\b/i },

  // Swahili
  { category: "cardiac", pattern: /\bmaumivu (makali )?ya kifua\b|\bkifua kinauma\b/i },
  { category: "breathing", pattern: /\b(siwezi|hawezi|anashindwa|nashindwa) kupumua\b|\bkushindwa kupumua\b/i },
  { category: "collapse_seizure", pattern: /\bdegedege\b|\bamezimia\b|\bkuzimia\b|\bhajitambui\b/i },
  { category: "severe_bleeding", pattern: /\b(kutokwa na|anatokwa na|natokwa na) damu nyingi\b|\bkutapika damu\b/i },
  { category: "self_harm", pattern: /\bkujiua\b|\bnataka kufa\b|\bkujidhuru\b/i },
  { category: "snake_bite", pattern: /\bkuumwa na nyoka\b|\bameumwa na nyoka\b/i },

  // Luganda (starting set; needs native-speaker review)
  { category: "cardiac", pattern: /\b(obulumi|okulumwa) mu kifuba\b|\bekifuba kiruma\b/i },
  { category: "breathing", pattern: /\b(sisobola|tasobola) kussa\b|\bokussa kuzibu\b/i },
  { category: "collapse_seizure", pattern: /\bazirise\b|\bokuzirika\b|\bensimbu\b/i },
  { category: "severe_bleeding", pattern: /\bomusaayi mungi\b|\bokusesema omusaayi\b/i },
  { category: "self_harm", pattern: /\bokwetta\b|\bnjagala okufa\b|\bnjagala kufa\b/i },
  { category: "snake_bite", pattern: /\bomusota (gumuluma|gunduma|kuluma)\b/i },
]

export type RedFlagResult = { emergency: boolean; categories: RedFlagCategory[] }

export function detectRedFlags(text: string): RedFlagResult {
  const categories = new Set<RedFlagCategory>()
  for (const rule of RED_FLAG_RULES) {
    if (rule.pattern.test(text)) categories.add(rule.category)
  }
  return { emergency: categories.size > 0, categories: [...categories] }
}

/**
 * Uganda emergency numbers. 112 and 999 reach emergency services from any
 * phone in Uganda; 116 is the free national child helpline (Sauti).
 * Keep this list short and verified; it is shown in every emergency reply.
 */
export const UGANDA_EMERGENCY_NUMBERS = [
  { number: "112", label: "Emergency (any network)" },
  { number: "999", label: "Police / emergency" },
  { number: "116", label: "Child helpline (Sauti, free)" },
] as const

const EMERGENCY_TEXT: Record<CompanionLanguage, { general: string; selfHarm: string }> = {
  en: {
    general:
      "What you describe can be a medical emergency. Please get care now: go to the nearest health facility or hospital, or call 112 or 999. If someone is with you, ask them to help you get there. I am not a doctor and cannot assess this safely in a chat.",
    selfHarm:
      "I'm really glad you told me. You deserve support right now. If you are in danger or might act on these thoughts, call 112 or 999, or go to the nearest health facility. Please also reach out to someone you trust and stay with them. I am an AI, not a counsellor, but I'm here to keep talking if it helps.",
  },
  sw: {
    general:
      "Unachoelezea kinaweza kuwa dharura ya kiafya. Tafadhali pata huduma sasa hivi: nenda kituo cha afya au hospitali iliyo karibu, au piga 112 au 999. Mimi si daktari na siwezi kutathmini hili kwa usalama kupitia gumzo.",
    selfHarm:
      "Asante kwa kuniambia. Unastahili msaada sasa hivi. Ikiwa uko hatarini, piga 112 au 999, au nenda kituo cha afya kilicho karibu. Mwambie mtu unayemwamini na ukae naye. Mimi ni AI, si mshauri, lakini niko hapa kuzungumza nawe.",
  },
  lg: {
    general:
      "By'oyogera biyinza okuba eby'amangu. Genda mu ddwaliro oba ku kifo eky'ebyobulamu ekikuli okumpi kati, oba kuba ku 112 oba 999. Nze siri musawo era sisobola kukebera kino mu bubaka.",
    selfHarm:
      "Weebale okuntegeeza. Weetaaga obuyambi kati. Bw'oba oli mu kabi, kuba ku 112 oba 999, oba genda mu ddwaliro ekikuli okumpi. Tegeeza omuntu gw'oyesiga obeere naye. Nze ndi AI, siri mubuulirizi, naye ndi wano okwogera naawe.",
  },
}

export function emergencyReply(language: CompanionLanguage, categories: RedFlagCategory[]): string {
  const text = EMERGENCY_TEXT[language] ?? EMERGENCY_TEXT.en
  return categories.includes("self_harm") && categories.length === 1 ? text.selfHarm : text.general
}

// ---------------------------------------------------------------------------
// Dose-change requests

const DOSE_OBJECT = String.raw`(dose|doses|dosage|tablets?|pills?|capsules?|medication|medicine|meds|insulin|drugs?|injections?|mg|ml)`
const DOSE_CHANGE_RULES: RegExp[] = [
  new RegExp(String.raw`\b(double|triple|increase|decrease|reduce|lower|raise|up|cut|halve|half|skip|split|change|adjust|alter)\b[^.?!]{0,40}\b${DOSE_OBJECT}\b`, "i"),
  new RegExp(String.raw`\b${DOSE_OBJECT}\b[^.?!]{0,30}\b(higher|lower|more|less|bigger|smaller|double|stronger)\b`, "i"),
  new RegExp(String.raw`\b(can|should|may|could)\s+i\s+(stop|quit|come off|take (an )?extra|take more|take less|take two|take another)\b`, "i"),
  /\bhow (much|many)\b[^.?!]{0,30}\b(mg|ml|tablets?|pills?|units?|capsules?)\b[^.?!]{0,30}\b(should|can|do) i\b/i,
  /\bwhat dose (should|can) i\b/i,
  // Swahili
  /\b(kuongeza|kupunguza|niongeze|nipunguze)\s+(dozi|dawa|vidonge)\b|\b(niache|kuacha)\s+(kutumia\s+)?dawa\b/i,
  // Luganda
  /\b(okwongera|okukendeeza)\s+(ku\s+)?(eddagala|dozi)\b|\b(nnekkire|okulekera awo)\s+(okumira\s+)?eddagala\b/i,
]

const CHANGE_VERB = /\b(double|triple|increase|decrease|reduce|lower|raise|cut|halve|skip|split|stop|quit|change|adjust|extra)\b/i

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * True when the user asks to start, stop or change a dose. `medicationNames`
 * (from the user's own record) catches "can I double my metformin?".
 */
export function isDoseChangeRequest(text: string, medicationNames: string[] = []): boolean {
  if (DOSE_CHANGE_RULES.some((rule) => rule.test(text))) return true
  if (!CHANGE_VERB.test(text)) return false
  return medicationNames.some((name) => {
    if (name.length < 4) return false
    const n = escapeRegExp(name)
    const v = CHANGE_VERB.source
    return new RegExp(`${v}[^.?!]{0,30}\\b${n}\\b|\\b${n}\\b[^.?!]{0,30}${v}`, "i").test(text)
  })
}

/** First word of each medication line ("Metformin 500mg twice daily" -> "metformin"). */
export function medicationNamesFrom(lines: string[]): string[] {
  return [...new Set(lines.map((l) => l.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase() ?? "").filter(Boolean))]
}

const DOSE_REFUSAL: Record<CompanionLanguage, string> = {
  en: "I can't advise starting, stopping or changing any dose. That decision needs your doctor, nurse or pharmacist, who knows your full history. Please don't change how you take a medicine on your own. If you have side effects or are worried, contact your clinic or pharmacist today, and if you feel very unwell, go to the nearest health facility. I can help you write down questions to ask them.",
  sw: "Siwezi kushauri kuanza, kuacha au kubadilisha dozi yoyote. Uamuzi huo unahitaji daktari, muuguzi au mfamasia wako. Tafadhali usibadilishe matumizi ya dawa peke yako. Ukiwa na madhara au wasiwasi, wasiliana na kliniki au mfamasia wako leo. Naweza kukusaidia kuandika maswali ya kuwauliza.",
  lg: "Sisobola kukuwa magezi ku kutandika, kulekera awo oba kukyusa dozi y'eddagala. Ekyo kyetaaga omusawo, omusawo omukyala oba omufamasiya wo. Tokyusa ngeri gy'omira eddagala ku lulwo. Bw'oba n'ebizibu, tuukirira ddwaliro lyo oba omufamasiya leero. Nsobola okukuyamba okuwandiika ebibuuzo by'onoobabuuza.",
}

export function doseRefusalReply(language: CompanionLanguage): string {
  return DOSE_REFUSAL[language] ?? DOSE_REFUSAL.en
}

// ---------------------------------------------------------------------------
// Output guard

const DOSE_MENTION = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|ml|iu|units?|tablets?|pills?|capsules?|puffs?)\b/gi
const NEGATED = /\b(don'?t|do not|never|not|without (talking|speaking|checking|asking))\b/i
const CHANGE_DIRECTIVE = new RegExp(
  String.raw`\b(increase|decrease|double|halve|reduce|lower|raise|stop taking|skip|start taking)\b[^.?!]{0,30}\b${DOSE_OBJECT}\b`,
  "i",
)
const DIAGNOSIS_ASSERTION =
  /\byou (definitely|certainly|clearly|probably|most likely) have\b|\byour diagnosis is\b|\bi (can )?diagnose\b|\byou are suffering from\b|\bthis (is|confirms) (definitely )?(a |an )?(case of )?(malaria|typhoid|diabetes|hypertension|hiv|tb|tuberculosis|cancer|pneumonia)\b/i

export type OutputGuardResult = { ok: true } | { ok: false; reason: "dose_directive" | "new_dose" | "diagnosis" }

function normaliseDose(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}

/**
 * Blocks replies that prescribe or diagnose. A dose the reply mentions is
 * allowed only when it already appears in the user's own record or message
 * (explaining "your metformin 500 mg twice a day" is fine; inventing one is not).
 */
export function guardModelOutput(reply: string, allowedText: string): OutputGuardResult {
  const allowed = new Set((allowedText.match(DOSE_MENTION) ?? []).map(normaliseDose))
  for (const mention of reply.match(DOSE_MENTION) ?? []) {
    if (!allowed.has(normaliseDose(mention))) return { ok: false, reason: "new_dose" }
  }
  for (const sentence of reply.split(/(?<=[.?!])\s+|\n+/)) {
    if (CHANGE_DIRECTIVE.test(sentence) && !NEGATED.test(sentence)) return { ok: false, reason: "dose_directive" }
  }
  if (DIAGNOSIS_ASSERTION.test(reply)) return { ok: false, reason: "diagnosis" }
  return { ok: true }
}

const BLOCKED_OUTPUT: Record<CompanionLanguage, string> = {
  en: "I started to give an answer that went beyond what I can safely say, so I've held it back. I can't diagnose conditions or recommend doses. A clinician or pharmacist can answer this properly; I can help you prepare questions for them or explain general information.",
  sw: "Nilianza kutoa jibu lililozidi kile ninachoweza kusema kwa usalama, kwa hiyo nimelizuia. Siwezi kutambua magonjwa au kupendekeza dozi. Daktari au mfamasia anaweza kujibu hili vizuri; naweza kukusaidia kuandaa maswali.",
  lg: "Ntandise okuddamu mu ngeri esukka ku kye nsobola okwogera mu bukuumi, kyenvudde nkiziyiza. Sisobola kuzuula bulwadde oba kuwa dozi. Omusawo oba omufamasiya y'asobola okuddamu kino; nsobola okukuyamba okutegeka ebibuuzo.",
}

export function blockedOutputReply(language: CompanionLanguage): string {
  return BLOCKED_OUTPUT[language] ?? BLOCKED_OUTPUT.en
}

export const NOT_A_DOCTOR_NOTICE: Record<CompanionLanguage, string> = {
  en: "Synapse Companion is an AI, not a doctor. It does not diagnose, prescribe or change doses. In an emergency call 112 or 999.",
  sw: "Synapse Companion ni AI, si daktari. Haitambui magonjwa, haiandiki dawa wala kubadilisha dozi. Kwa dharura piga 112 au 999.",
  lg: "Synapse Companion AI, si musawo. Tezuula bulwadde, tewandiika ddagala era tekyusa dozi. Mu bw'amangu kuba ku 112 oba 999.",
}

export function normaliseLanguage(value: unknown): CompanionLanguage {
  return value === "lg" || value === "sw" ? value : "en"
}
