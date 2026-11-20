/**
 * Synapse differential engine: explainable, deterministic, offline.
 *
 * As the clinician records the complaint, history, examination and vitals,
 * it ranks likely diagnoses for a Ugandan outpatient setting, says why
 * (findings for and against), lists what to ask or examine next, and the
 * investigations that confirm or exclude each one.
 *
 * Decision support only: it never saves a diagnosis or a code. The clinician
 * picks, and the diagnoses route checks the code against the WHO index.
 * Every ICD-11 code below is checked against the WHO 2026-01 tabulation by
 * differential-engine.test.ts.
 *
 * Pure TypeScript with no I/O, so the consultation screen runs it on every
 * keystroke in the browser.
 */

export const DIFFERENTIAL_ENGINE_VERSION = "ug-opd.2026-11.1"

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingGroup = "symptom" | "sign" | "history" | "vital"
export type BodySystem =
  | "general" | "respiratory" | "ent" | "gastrointestinal" | "genitourinary"
  | "neurological" | "skin" | "cardiovascular" | "obstetric" | "musculoskeletal" | "endocrine" | "eye"

export type FindingDef = {
  label: string
  group: FindingGroup
  system: BodySystem
  /** Lower-case phrases that mean this finding in a free-text note. */
  synonyms?: string[]
}

export const FINDINGS = {
  // General
  fever: { label: "Fever", group: "symptom", system: "general", synonyms: ["fever", "febrile", "hotness of body", "hot body", "feverish", "pyrexia"] },
  chills: { label: "Chills / rigors", group: "symptom", system: "general", synonyms: ["chills", "rigors", "shivering", "feeling cold"] },
  headache: { label: "Headache", group: "symptom", system: "neurological", synonyms: ["headache", "head ache", "head pain"] },
  myalgia: { label: "Body / joint pains", group: "symptom", system: "musculoskeletal", synonyms: ["joint pain", "joint pains", "body pain", "body pains", "myalgia", "arthralgia", "body aches"] },
  fatigue: { label: "Weakness / fatigue", group: "symptom", system: "general", synonyms: ["body weakness", "weakness", "fatigue", "tired", "malaise", "lethargy"] },
  anorexia: { label: "Loss of appetite", group: "symptom", system: "general", synonyms: ["loss of appetite", "poor appetite", "anorexia", "not eating"] },
  weight_loss: { label: "Weight loss", group: "symptom", system: "general", synonyms: ["weight loss", "losing weight", "lost weight"] },
  night_sweats: { label: "Night sweats", group: "symptom", system: "general", synonyms: ["night sweats", "sweating at night", "drenching sweats"] },
  prostration: { label: "Unable to sit / stand (prostration)", group: "sign", system: "general", synonyms: ["prostration", "unable to sit", "unable to stand", "cannot stand"] },
  pallor: { label: "Pallor", group: "sign", system: "general", synonyms: ["pallor", "pale", "palor"] },
  jaundice: { label: "Jaundice (yellow eyes)", group: "sign", system: "general", synonyms: ["jaundice", "yellow eyes", "yellowing of eyes", "icterus", "yellow skin"] },
  dehydration: { label: "Signs of dehydration", group: "sign", system: "general", synonyms: ["dehydrated", "dehydration", "sunken eyes", "dry mucosa", "reduced skin turgor"] },
  lymphadenopathy: { label: "Lymphadenopathy", group: "sign", system: "general", synonyms: ["lymphadenopathy", "swollen glands", "enlarged lymph nodes"] },
  oral_thrush: { label: "Oral thrush", group: "sign", system: "ent", synonyms: ["oral thrush", "oral candidiasis", "white patches in mouth"] },

  // Respiratory / ENT
  cough: { label: "Cough", group: "symptom", system: "respiratory", synonyms: ["cough", "coughing"] },
  cough_2wk: { label: "Cough 2 weeks or more", group: "history", system: "respiratory", synonyms: ["chronic cough", "cough for 2 weeks", "cough for two weeks", "cough for 3 weeks", "cough for a month", "persistent cough"] },
  productive_cough: { label: "Productive cough", group: "symptom", system: "respiratory", synonyms: ["productive cough", "sputum", "phlegm"] },
  haemoptysis: { label: "Coughing blood", group: "symptom", system: "respiratory", synonyms: ["haemoptysis", "hemoptysis", "coughing blood", "blood in sputum"] },
  dyspnoea: { label: "Difficulty in breathing", group: "symptom", system: "respiratory", synonyms: ["difficulty in breathing", "difficulty breathing", "shortness of breath", "breathlessness", "dyspnoea", "dyspnea", "sob"] },
  wheeze: { label: "Wheeze", group: "sign", system: "respiratory", synonyms: ["wheeze", "wheezing", "rhonchi"] },
  chest_pain: { label: "Chest pain", group: "symptom", system: "cardiovascular", synonyms: ["chest pain", "chest tightness"] },
  pleuritic_pain: { label: "Pain on breathing in", group: "symptom", system: "respiratory", synonyms: ["pleuritic", "pain on breathing", "pain on inspiration"] },
  crepitations: { label: "Crepitations / crackles", group: "sign", system: "respiratory", synonyms: ["crepitations", "crackles", "creps", "rales"] },
  bronchial_breathing: { label: "Bronchial breathing / dullness", group: "sign", system: "respiratory", synonyms: ["bronchial breathing", "dull percussion", "dullness"] },
  chest_indrawing: { label: "Chest indrawing", group: "sign", system: "respiratory", synonyms: ["chest indrawing", "subcostal recession", "intercostal recession"] },
  runny_nose: { label: "Runny / blocked nose", group: "symptom", system: "ent", synonyms: ["runny nose", "flu", "rhinorrhoea", "rhinorrhea", "nasal discharge", "blocked nose", "sneezing", "catarrh"] },
  sore_throat: { label: "Sore throat", group: "symptom", system: "ent", synonyms: ["sore throat", "painful swallowing", "odynophagia", "throat pain"] },
  tonsillar_exudate: { label: "Tonsillar exudate / swelling", group: "sign", system: "ent", synonyms: ["tonsillar exudate", "enlarged tonsils", "inflamed tonsils", "pus on tonsils"] },
  ear_pain: { label: "Ear pain", group: "symptom", system: "ent", synonyms: ["ear pain", "earache", "otalgia"] },
  ear_discharge: { label: "Ear discharge", group: "symptom", system: "ent", synonyms: ["ear discharge", "otorrhoea", "pus from ear"] },
  bulging_tm: { label: "Red / bulging eardrum", group: "sign", system: "ent", synonyms: ["bulging tympanic", "red tympanic", "bulging eardrum", "hyperaemic tm"] },
  red_eye: { label: "Red eye / eye discharge", group: "symptom", system: "eye", synonyms: ["red eye", "red eyes", "eye discharge", "sticky eyes", "itchy eyes"] },

  // Gastrointestinal
  nausea: { label: "Nausea", group: "symptom", system: "gastrointestinal", synonyms: ["nausea", "nauseated"] },
  vomiting: { label: "Vomiting", group: "symptom", system: "gastrointestinal", synonyms: ["vomiting", "vomit", "vomits", "emesis"] },
  diarrhoea: { label: "Diarrhoea", group: "symptom", system: "gastrointestinal", synonyms: ["diarrhoea", "diarrhea", "loose stool", "loose stools", "watery stool", "running stomach"] },
  rice_water_stool: { label: "Profuse watery (rice-water) stool", group: "symptom", system: "gastrointestinal", synonyms: ["rice water", "profuse watery"] },
  bloody_stool: { label: "Blood / mucus in stool", group: "symptom", system: "gastrointestinal", synonyms: ["bloody stool", "blood in stool", "bloody diarrhoea", "bloody diarrhea", "mucoid stool", "mucus in stool", "dysentery"] },
  epigastric_pain: { label: "Epigastric pain", group: "symptom", system: "gastrointestinal", synonyms: ["epigastric pain", "upper abdominal pain", "stomach pain", "epigastric"] },
  heartburn: { label: "Heartburn / acid reflux", group: "symptom", system: "gastrointestinal", synonyms: ["heartburn", "heart burn", "acid reflux", "sour taste", "regurgitation"] },
  abdominal_pain: { label: "Abdominal pain", group: "symptom", system: "gastrointestinal", synonyms: ["abdominal pain", "abdominal pains", "tummy pain", "abdomen pain"] },
  rlq_pain: { label: "Right lower abdominal pain", group: "symptom", system: "gastrointestinal", synonyms: ["right lower quadrant", "right iliac fossa", "rif pain", "rlq pain", "periumbilical pain moving"] },
  constipation: { label: "Constipation", group: "symptom", system: "gastrointestinal", synonyms: ["constipation", "constipated", "no stool"] },
  rlq_tenderness: { label: "Right iliac fossa tenderness", group: "sign", system: "gastrointestinal", synonyms: ["rif tenderness", "mcburney", "right iliac fossa tenderness"] },
  guarding: { label: "Guarding / rebound tenderness", group: "sign", system: "gastrointestinal", synonyms: ["guarding", "rebound tenderness", "rigidity", "peritonism"] },
  epigastric_tenderness: { label: "Epigastric tenderness", group: "sign", system: "gastrointestinal", synonyms: ["epigastric tenderness"] },
  splenomegaly: { label: "Splenomegaly", group: "sign", system: "gastrointestinal", synonyms: ["splenomegaly", "enlarged spleen", "palpable spleen"] },
  hepatomegaly: { label: "Hepatomegaly", group: "sign", system: "gastrointestinal", synonyms: ["hepatomegaly", "enlarged liver", "tender liver"] },

  // Genitourinary / obstetric
  dysuria: { label: "Pain / burning on passing urine", group: "symptom", system: "genitourinary", synonyms: ["dysuria", "burning urine", "burning micturition", "painful urination", "pain on passing urine", "burning on passing urine"] },
  frequency: { label: "Frequent / urgent urination", group: "symptom", system: "genitourinary", synonyms: ["frequency", "urgency", "frequent urination", "passing urine frequently"] },
  suprapubic_pain: { label: "Lower abdominal / suprapubic pain", group: "symptom", system: "genitourinary", synonyms: ["suprapubic pain", "lower abdominal pain", "lower abdominal pains", "pelvic pain"] },
  flank_pain: { label: "Loin / flank pain", group: "symptom", system: "genitourinary", synonyms: ["flank pain", "loin pain", "back pain", "renal angle"] },
  renal_angle_tenderness: { label: "Renal angle tenderness", group: "sign", system: "genitourinary", synonyms: ["renal angle tenderness", "costovertebral tenderness", "cva tenderness"] },
  haematuria: { label: "Blood in urine", group: "symptom", system: "genitourinary", synonyms: ["haematuria", "hematuria", "blood in urine", "red urine"] },
  dark_urine: { label: "Dark / cola urine", group: "symptom", system: "genitourinary", synonyms: ["dark urine", "cola urine", "coca cola urine", "tea coloured urine"] },
  vaginal_discharge: { label: "Abnormal vaginal discharge", group: "symptom", system: "genitourinary", synonyms: ["vaginal discharge", "pv discharge", "foul discharge"] },
  urethral_discharge: { label: "Urethral discharge", group: "symptom", system: "genitourinary", synonyms: ["urethral discharge", "penile discharge", "pus from penis"] },
  cervical_motion_tenderness: { label: "Cervical motion / adnexal tenderness", group: "sign", system: "genitourinary", synonyms: ["cervical motion tenderness", "cervical excitation", "adnexal tenderness"] },
  missed_period: { label: "Missed period", group: "history", system: "obstetric", synonyms: ["missed period", "amenorrhoea", "amenorrhea", "lmp", "late period"] },
  pv_bleeding: { label: "Vaginal bleeding", group: "symptom", system: "obstetric", synonyms: ["pv bleeding", "vaginal bleeding", "bleeding per vagina"] },
  visual_disturbance: { label: "Blurred vision / flashes", group: "symptom", system: "neurological", synonyms: ["blurred vision", "blurring of vision", "flashes of light", "visual disturbance"] },
  oedema: { label: "Leg / body swelling (oedema)", group: "sign", system: "cardiovascular", synonyms: ["oedema", "edema", "swollen legs", "leg swelling", "pitting"] },

  // Neurological
  neck_stiffness: { label: "Neck stiffness", group: "sign", system: "neurological", synonyms: ["neck stiffness", "stiff neck", "kernig", "brudzinski", "nuchal rigidity"] },
  photophobia: { label: "Photophobia", group: "symptom", system: "neurological", synonyms: ["photophobia", "fear of light"] },
  confusion: { label: "Confusion / reduced consciousness", group: "sign", system: "neurological", synonyms: ["confusion", "confused", "altered consciousness", "drowsy", "unconscious", "gcs"] },
  convulsions: { label: "Convulsions", group: "symptom", system: "neurological", synonyms: ["convulsions", "convulsion", "seizure", "seizures", "fits", "fitting"] },
  unilateral_headache: { label: "One-sided, throbbing headache", group: "symptom", system: "neurological", synonyms: ["throbbing", "one sided headache", "unilateral headache", "pulsating"] },
  band_headache: { label: "Band-like, pressing headache", group: "symptom", system: "neurological", synonyms: ["band like", "tight band", "pressing headache"] },

  // Skin / MSK
  rash: { label: "Rash", group: "sign", system: "skin", synonyms: ["rash", "skin rash", "eruption"] },
  itch: { label: "Itching", group: "symptom", system: "skin", synonyms: ["itch", "itching", "itchy", "pruritus"] },
  itch_worse_night: { label: "Itching worse at night / family affected", group: "history", system: "skin", synonyms: ["worse at night", "itching at night", "family members itching"] },
  skin_red_swollen: { label: "Red, hot, swollen skin", group: "sign", system: "skin", synonyms: ["cellulitis", "red swollen", "hot swollen", "warm swollen", "redness and swelling"] },
  bone_pain: { label: "Severe bone / limb pain", group: "symptom", system: "musculoskeletal", synonyms: ["bone pain", "bone pains", "limb pain", "pain crisis"] },
  back_joint_pain_chronic: { label: "Recurrent fever with joint / back pain", group: "history", system: "musculoskeletal", synonyms: ["undulant fever", "recurrent fever", "on and off fever"] },

  // Cardio / endocrine
  palpitations: { label: "Palpitations", group: "symptom", system: "cardiovascular", synonyms: ["palpitations", "heart racing"] },
  orthopnoea: { label: "Breathless lying flat", group: "symptom", system: "cardiovascular", synonyms: ["orthopnoea", "orthopnea", "pnd", "breathless lying", "uses pillows"] },
  raised_jvp: { label: "Raised JVP", group: "sign", system: "cardiovascular", synonyms: ["raised jvp", "elevated jvp", "distended neck veins"] },
  polyuria: { label: "Passing a lot of urine", group: "symptom", system: "endocrine", synonyms: ["polyuria", "passing a lot of urine", "frequent urination at night", "nocturia"] },
  polydipsia: { label: "Excessive thirst", group: "symptom", system: "endocrine", synonyms: ["polydipsia", "excessive thirst", "very thirsty"] },
  deep_breathing: { label: "Deep sighing breathing", group: "sign", system: "endocrine", synonyms: ["kussmaul", "acidotic breathing", "deep breathing", "fruity breath"] },

  // History / context
  known_hiv: { label: "Known HIV positive", group: "history", system: "general", synonyms: ["hiv positive", "rvd", "on art", "pliv", "plhiv"] },
  known_diabetes: { label: "Known diabetic", group: "history", system: "endocrine", synonyms: ["known diabetic", "diabetic", "on metformin", "on insulin"] },
  known_hypertension: { label: "Known hypertensive", group: "history", system: "cardiovascular", synonyms: ["known hypertensive", "hypertensive", "on amlodipine", "on nifedipine"] },
  known_sickle_cell: { label: "Known sickle cell disease", group: "history", system: "general", synonyms: ["sickle cell", "scd", "sickler"] },
  known_asthma: { label: "Known asthmatic", group: "history", system: "respiratory", synonyms: ["known asthmatic", "asthmatic", "uses inhaler"] },
  tb_contact: { label: "TB contact", group: "history", system: "respiratory", synonyms: ["tb contact", "contact with tb"] },
  raw_milk: { label: "Raw milk / animal contact", group: "history", system: "general", synonyms: ["raw milk", "unboiled milk", "cattle keeper", "goats", "animal contact", "abattoir"] },
  unsafe_water: { label: "Unsafe water / food / outbreak area", group: "history", system: "gastrointestinal", synonyms: ["unsafe water", "street food", "outbreak", "contaminated water"] },
  new_sexual_partner: { label: "New / multiple sexual partners", group: "history", system: "genitourinary", synonyms: ["new partner", "multiple partners", "unprotected sex"] },
  nsaid_use: { label: "NSAID / alcohol use", group: "history", system: "gastrointestinal", synonyms: ["diclofenac", "ibuprofen", "aspirin", "nsaid", "alcohol", "brufen"] },
  wheeze_triggers: { label: "Triggered by dust / cold / exercise", group: "history", system: "respiratory", synonyms: ["dust", "cold weather", "on exertion", "triggers", "allergy"] },
  recurrent_wheeze: { label: "Recurrent episodes of wheeze", group: "history", system: "respiratory", synonyms: ["recurrent wheeze", "previous attacks", "similar episodes"] },

  // From vitals (set by vitalFindings, not typed)
  v_fever: { label: "Temperature 37.5 °C or above", group: "vital", system: "general" },
  v_high_fever: { label: "Temperature 39 °C or above", group: "vital", system: "general" },
  v_hypothermia: { label: "Temperature below 36 °C", group: "vital", system: "general" },
  v_tachycardia: { label: "Heart rate above normal", group: "vital", system: "cardiovascular" },
  v_tachypnoea: { label: "Fast breathing for age", group: "vital", system: "respiratory" },
  v_hypoxia: { label: "SpO₂ below 94%", group: "vital", system: "respiratory" },
  v_hypotension: { label: "Systolic BP below 90", group: "vital", system: "cardiovascular" },
  v_bp_high: { label: "BP 140/90 or above", group: "vital", system: "cardiovascular" },
  v_bp_crisis: { label: "BP 180/120 or above", group: "vital", system: "cardiovascular" },
} satisfies Record<string, FindingDef>

export type FindingId = keyof typeof FINDINGS
export type FindingState = "present" | "absent"
export type FindingMap = Partial<Record<FindingId, FindingState>>

export const FINDING_IDS = Object.keys(FINDINGS) as FindingId[]

export function findingLabel(id: FindingId): string {
  return FINDINGS[id].label
}

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

export type InvestigationKind = "lab" | "imaging" | "bedside"

export type InvestigationDef = {
  /** Matches lab_test_catalog.code where it exists (the starter catalogue codes). */
  code: string
  name: string
  kind: InvestigationKind
  /** Only where the LOINC is certain; otherwise matched by code or name. */
  loinc?: string
}

export const INVESTIGATIONS = {
  MRDT: { code: "MRDT", name: "Malaria RDT", kind: "lab", loinc: "58413-6" },
  BS: { code: "BS", name: "Blood smear for malaria parasites", kind: "lab" },
  FBC: { code: "FBC", name: "Full blood count", kind: "lab", loinc: "58410-2" },
  HB: { code: "HB", name: "Haemoglobin", kind: "lab", loinc: "718-7" },
  CRP: { code: "CRP", name: "C-reactive protein", kind: "lab", loinc: "1988-5" },
  GLU: { code: "GLU", name: "Blood glucose", kind: "lab", loinc: "2345-7" },
  HBA1C: { code: "HBA1C", name: "HbA1c", kind: "lab", loinc: "4548-4" },
  CREA: { code: "CREA", name: "Creatinine", kind: "lab", loinc: "2160-0" },
  UREA: { code: "UREA", name: "Urea", kind: "lab", loinc: "3094-0" },
  NA: { code: "NA", name: "Sodium", kind: "lab", loinc: "2951-2" },
  K: { code: "K", name: "Potassium", kind: "lab", loinc: "2823-3" },
  ALT: { code: "ALT", name: "ALT", kind: "lab", loinc: "1742-6" },
  TBIL: { code: "TBIL", name: "Total bilirubin", kind: "lab", loinc: "1975-2" },
  HIV: { code: "HIV", name: "HIV 1+2 rapid test", kind: "lab", loinc: "75622-1" },
  HCG: { code: "HCG", name: "Pregnancy test (urine hCG)", kind: "lab", loinc: "2106-3" },
  URINE: { code: "URINE", name: "Urinalysis (dipstick and microscopy)", kind: "lab", loinc: "24356-8" },
  STOOL: { code: "STOOL", name: "Stool microscopy (ova/cysts)", kind: "lab", loinc: "10701-0" },
  BLOOD_CULTURE: { code: "BLOOD_CULTURE", name: "Blood culture", kind: "lab", loinc: "600-7" },
  URINE_CULTURE: { code: "URINE_CULTURE", name: "Urine culture", kind: "lab", loinc: "630-4" },
  STOOL_CULTURE: { code: "STOOL_CULTURE", name: "Stool culture", kind: "lab" },
  HBSAG: { code: "HBSAG", name: "Hepatitis B surface antigen", kind: "lab", loinc: "5196-1" },
  RPR: { code: "RPR", name: "Syphilis RPR", kind: "lab", loinc: "20507-0" },
  GENEXPERT: { code: "GENEXPERT", name: "Sputum GeneXpert MTB/RIF", kind: "lab" },
  SPUTUM_AFB: { code: "SPUTUM_AFB", name: "Sputum smear for AFB", kind: "lab" },
  CSF: { code: "CSF", name: "Lumbar puncture: CSF analysis and culture", kind: "lab" },
  BRUCELLA: { code: "BRUCELLA", name: "Brucella serology", kind: "lab" },
  SICKLING: { code: "SICKLING", name: "Sickling test / Hb electrophoresis", kind: "lab" },
  HVS: { code: "HVS", name: "High vaginal / cervical swab", kind: "lab" },
  URETHRAL_SWAB: { code: "URETHRAL_SWAB", name: "Urethral swab Gram stain", kind: "lab" },
  SKIN_SCRAPING: { code: "SKIN_SCRAPING", name: "Skin scraping microscopy", kind: "lab" },
  THROAT_SWAB: { code: "THROAT_SWAB", name: "Throat swab culture", kind: "lab" },
  CXR: { code: "CXR", name: "Chest X-ray", kind: "imaging" },
  ABD_US: { code: "ABD_US", name: "Abdominal ultrasound", kind: "imaging" },
  PELVIC_US: { code: "PELVIC_US", name: "Pelvic / transvaginal ultrasound", kind: "imaging" },
  ECHO: { code: "ECHO", name: "Echocardiogram", kind: "imaging" },
  ECG: { code: "ECG", name: "ECG", kind: "bedside" },
  PEAK_FLOW: { code: "PEAK_FLOW", name: "Peak flow", kind: "bedside" },
  URINE_PROTEIN: { code: "URINE_PROTEIN", name: "Urine protein (dipstick)", kind: "bedside" },
  URINE_KETONES: { code: "URINE_KETONES", name: "Urine ketones (dipstick)", kind: "bedside" },
  OTOSCOPY: { code: "OTOSCOPY", name: "Otoscopy", kind: "bedside" },
} satisfies Record<string, InvestigationDef>

export type InvestigationCode = keyof typeof INVESTIGATIONS
export type InvestigationPurpose = "confirm" | "exclude" | "severity"

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export type PatientContext = {
  ageYears?: number | null
  sex?: "M" | "F" | null
  pregnant?: boolean | null
}

type Feature = [FindingId, number]

export type ConditionDef = {
  id: string
  name: string
  icd11: { code: string; title: string }
  /** Other WHO codes the clinician may pick instead (e.g. unconfirmed malaria). */
  icd11Alternatives?: { code: string; title: string; when: string }[]
  /** Base weight: how common it is in Ugandan OPD (0-3). */
  prior: number
  features: Feature[]
  /** Shown only when at least one of these is present. */
  requiresAny: FindingId[]
  applies?: (ctx: PatientContext) => boolean
  redFlags?: FindingId[]
  investigations: [InvestigationCode, InvestigationPurpose, string][]
  /** One line of what matters clinically, shown under the diagnosis. */
  pearl?: string
  urgentIfRedFlag?: boolean
}

const isFemale = (c: PatientContext) => c.sex !== "M"
const childBearing = (c: PatientContext) => isFemale(c) && (c.ageYears == null || (c.ageYears >= 12 && c.ageYears <= 55))

export const CONDITIONS: ConditionDef[] = [
  {
    id: "malaria",
    name: "Uncomplicated malaria",
    icd11: { code: "1F40.Z", title: "Malaria due to Plasmodium falciparum, unspecified" },
    icd11Alternatives: [{ code: "1F45", title: "Malaria without parasitological confirmation", when: "if no RDT or smear was done" }],
    prior: 3,
    features: [["fever", 3], ["v_fever", 2], ["v_high_fever", 1], ["chills", 2], ["headache", 1.5], ["myalgia", 1.5], ["fatigue", 1], ["anorexia", 0.5], ["vomiting", 1], ["splenomegaly", 1.5], ["pallor", 0.5], ["runny_nose", -1], ["dysuria", -1], ["productive_cough", -1]],
    requiresAny: ["fever", "v_fever", "chills"],
    redFlags: ["confusion", "convulsions", "prostration", "jaundice", "dark_urine", "v_hypoxia", "v_hypotension", "dyspnoea"],
    investigations: [["MRDT", "confirm", "Test every suspected case before treating"], ["BS", "confirm", "Smear if RDT negative and suspicion stays high, or to count parasites"], ["HB", "severity", "Check for anaemia"]],
    pearl: "Any danger sign makes it severe malaria: treat with IV/IM artesunate.",
  },
  {
    id: "severe_malaria",
    name: "Severe malaria",
    icd11: { code: "1F40.Y", title: "Other severe or complicated Plasmodium falciparum malaria" },
    icd11Alternatives: [{ code: "1F40.0", title: "Plasmodium falciparum malaria with cerebral complications", when: "if impaired consciousness or convulsions" }],
    prior: 1,
    features: [["fever", 2], ["v_fever", 1.5], ["confusion", 3], ["convulsions", 3], ["prostration", 3], ["jaundice", 2], ["dark_urine", 2.5], ["v_hypoxia", 1.5], ["dyspnoea", 1.5], ["pallor", 1.5], ["vomiting", 1], ["v_hypotension", 1.5]],
    requiresAny: ["confusion", "convulsions", "prostration", "jaundice", "dark_urine"],
    redFlags: ["confusion", "convulsions", "prostration", "v_hypotension", "v_hypoxia"],
    investigations: [["MRDT", "confirm", "Confirm malaria"], ["BS", "severity", "Parasite count"], ["HB", "severity", "Severe anaemia (Hb < 5 g/dL)"], ["GLU", "severity", "Hypoglycaemia"], ["CREA", "severity", "Kidney injury"]],
    pearl: "Emergency: IV artesunate, check glucose, admit.",
    urgentIfRedFlag: true,
  },
  {
    id: "typhoid",
    name: "Typhoid fever",
    icd11: { code: "1A07.Z", title: "Typhoid fever, unspecified" },
    prior: 1.5,
    features: [["fever", 2.5], ["v_fever", 1.5], ["headache", 1.5], ["abdominal_pain", 1.5], ["constipation", 1.5], ["diarrhoea", 0.5], ["anorexia", 1], ["fatigue", 1], ["hepatomegaly", 1], ["splenomegaly", 0.5], ["unsafe_water", 1.5], ["chills", -0.5], ["runny_nose", -1]],
    requiresAny: ["fever", "v_fever"],
    redFlags: ["guarding", "confusion", "bloody_stool"],
    investigations: [["BLOOD_CULTURE", "confirm", "Blood culture in the first week is the test of choice"], ["MRDT", "exclude", "Exclude malaria first"], ["FBC", "severity", "Leukopenia supports it"]],
    pearl: "Widal alone does not confirm typhoid. Guarding may mean perforation.",
  },
  {
    id: "pneumonia",
    name: "Pneumonia",
    icd11: { code: "CA40.Z", title: "Pneumonia, organism unspecified" },
    prior: 2,
    features: [["cough", 2.5], ["productive_cough", 1.5], ["fever", 1.5], ["v_fever", 1], ["dyspnoea", 2], ["v_tachypnoea", 2.5], ["chest_indrawing", 2.5], ["crepitations", 3], ["bronchial_breathing", 3], ["pleuritic_pain", 1.5], ["v_hypoxia", 2], ["runny_nose", -0.5], ["wheeze", -0.5]],
    requiresAny: ["cough", "dyspnoea", "v_tachypnoea", "crepitations"],
    redFlags: ["v_hypoxia", "confusion", "chest_indrawing", "v_hypotension"],
    investigations: [["CXR", "confirm", "Consolidation"], ["FBC", "severity", "Raised white cells"], ["CRP", "severity", "Supports bacterial cause"], ["MRDT", "exclude", "Fever plus fast breathing can be malaria"]],
    pearl: "SpO₂ below 90%, confusion or chest indrawing: give oxygen and admit.",
  },
  {
    id: "urti",
    name: "Common cold / upper respiratory infection",
    icd11: { code: "CA07.0", title: "Acute upper respiratory infection, site unspecified" },
    prior: 3,
    features: [["runny_nose", 3], ["cough", 1.5], ["sore_throat", 1.5], ["fever", 0.5], ["headache", 0.5], ["crepitations", -2.5], ["v_tachypnoea", -1.5], ["v_hypoxia", -2]],
    requiresAny: ["runny_nose", "sore_throat", "cough"],
    investigations: [["MRDT", "exclude", "If there is fever"]],
    pearl: "Viral and self-limiting: no antibiotics.",
  },
  {
    id: "tonsillitis",
    name: "Acute tonsillitis / pharyngitis",
    icd11: { code: "CA03.Z", title: "Acute tonsillitis, unspecified" },
    icd11Alternatives: [{ code: "CA02.Z", title: "Acute pharyngitis, unspecified", when: "if the tonsils are not involved" }],
    prior: 2,
    features: [["sore_throat", 3], ["tonsillar_exudate", 3], ["fever", 1.5], ["v_fever", 1], ["lymphadenopathy", 1], ["cough", -1.5], ["runny_nose", -1]],
    requiresAny: ["sore_throat", "tonsillar_exudate"],
    investigations: [["THROAT_SWAB", "confirm", "Only if available; treat on clinical grounds"]],
    pearl: "Exudate, fever and no cough suggest streptococcal tonsillitis: give penicillin to prevent rheumatic fever.",
  },
  {
    id: "otitis_media",
    name: "Acute otitis media",
    icd11: { code: "AB00", title: "Acute otitis media" },
    prior: 1.5,
    features: [["ear_pain", 3], ["ear_discharge", 2.5], ["bulging_tm", 3.5], ["fever", 1], ["runny_nose", 0.5]],
    requiresAny: ["ear_pain", "ear_discharge", "bulging_tm"],
    investigations: [["OTOSCOPY", "confirm", "Red, bulging eardrum"]],
  },
  {
    id: "bronchitis",
    name: "Acute bronchitis",
    icd11: { code: "CA42.Z", title: "Acute bronchitis, unspecified" },
    prior: 1.5,
    features: [["cough", 3], ["productive_cough", 1.5], ["wheeze", 0.5], ["fever", 0.5], ["crepitations", -1.5], ["v_tachypnoea", -1.5], ["v_hypoxia", -2], ["cough_2wk", -1]],
    requiresAny: ["cough"],
    investigations: [["CXR", "exclude", "Only if pneumonia is suspected"]],
    pearl: "Usually viral; antibiotics rarely help.",
  },
  {
    id: "asthma",
    name: "Asthma exacerbation",
    icd11: { code: "CA23", title: "Asthma" },
    prior: 1,
    features: [["wheeze", 3.5], ["dyspnoea", 2], ["cough", 1], ["chest_pain", 0.5], ["known_asthma", 3], ["recurrent_wheeze", 2.5], ["wheeze_triggers", 1.5], ["fever", -0.5], ["crepitations", -1]],
    requiresAny: ["wheeze", "known_asthma", "recurrent_wheeze"],
    redFlags: ["v_hypoxia", "confusion"],
    investigations: [["PEAK_FLOW", "severity", "Compare with best or predicted"]],
    pearl: "Silent chest, SpO₂ below 92% or unable to speak in sentences: life-threatening.",
  },
  {
    id: "ptb",
    name: "Pulmonary tuberculosis",
    icd11: { code: "1B10.Z", title: "Respiratory tuberculosis, without mention of bacteriological or histological confirmation" },
    icd11Alternatives: [{ code: "1B10.0", title: "Respiratory tuberculosis, confirmed", when: "once GeneXpert or smear is positive" }],
    prior: 1,
    features: [["cough_2wk", 4], ["cough", 1], ["night_sweats", 2.5], ["weight_loss", 2.5], ["haemoptysis", 2.5], ["fever", 1], ["known_hiv", 2], ["tb_contact", 2.5], ["lymphadenopathy", 1], ["fatigue", 0.5]],
    requiresAny: ["cough_2wk", "night_sweats", "weight_loss", "haemoptysis"],
    investigations: [["GENEXPERT", "confirm", "First test for every presumptive TB"], ["CXR", "confirm", "Supports when GeneXpert is negative"], ["HIV", "severity", "Test every TB patient"]],
    pearl: "Cough for 2 weeks or more is presumptive TB: send sputum.",
  },
  {
    id: "uti",
    name: "Urinary tract infection (cystitis)",
    icd11: { code: "GC08", title: "Urinary tract infection, site not specified" },
    icd11Alternatives: [{ code: "GC00.Z", title: "Cystitis, unspecified", when: "if confined to the bladder" }],
    prior: 2,
    features: [["dysuria", 3.5], ["frequency", 2.5], ["suprapubic_pain", 2], ["haematuria", 1], ["fever", 0.5], ["vaginal_discharge", -1.5], ["urethral_discharge", -1]],
    requiresAny: ["dysuria", "frequency", "suprapubic_pain"],
    investigations: [["URINE", "confirm", "Nitrites and leucocytes"], ["URINE_CULTURE", "confirm", "In recurrent, complicated or pregnant cases"], ["HCG", "exclude", "Women of childbearing age"]],
    pearl: "In pregnancy, always treat and send a culture.",
  },
  {
    id: "pyelonephritis",
    name: "Acute pyelonephritis",
    icd11: { code: "GB51", title: "Acute pyelonephritis" },
    prior: 1,
    features: [["flank_pain", 3], ["renal_angle_tenderness", 3.5], ["fever", 2], ["v_fever", 1.5], ["dysuria", 1.5], ["frequency", 1], ["vomiting", 1], ["chills", 1]],
    requiresAny: ["flank_pain", "renal_angle_tenderness"],
    redFlags: ["v_hypotension", "confusion"],
    investigations: [["URINE", "confirm", "Pyuria"], ["URINE_CULTURE", "confirm", "Always"], ["CREA", "severity", "Kidney function"], ["FBC", "severity", "Leucocytosis"]],
  },
  {
    id: "gastroenteritis",
    name: "Acute gastroenteritis",
    icd11: { code: "1A40.Z", title: "Infectious gastroenteritis or colitis without specification of infectious agent" },
    prior: 2.5,
    features: [["diarrhoea", 3.5], ["vomiting", 2], ["abdominal_pain", 1], ["nausea", 1], ["fever", 0.5], ["dehydration", 1], ["bloody_stool", -1.5], ["rice_water_stool", -0.5]],
    requiresAny: ["diarrhoea", "vomiting"],
    redFlags: ["dehydration", "v_hypotension", "confusion"],
    investigations: [["STOOL", "confirm", "If it lasts more than a few days"], ["NA", "severity", "If dehydrated"], ["K", "severity", "If dehydrated"]],
    pearl: "Assess dehydration first: ORS and zinc for children.",
  },
  {
    id: "dysentery",
    name: "Dysentery (bacillary or amoebic)",
    icd11: { code: "1A02", title: "Intestinal infections due to Shigella" },
    icd11Alternatives: [{ code: "1A36.00", title: "Acute amoebiasis", when: "if trophozoites are seen on stool microscopy" }],
    prior: 1,
    features: [["bloody_stool", 4], ["diarrhoea", 2], ["abdominal_pain", 1.5], ["fever", 1], ["v_fever", 0.5]],
    requiresAny: ["bloody_stool"],
    redFlags: ["dehydration", "v_hypotension"],
    investigations: [["STOOL", "confirm", "Trophozoites, pus cells"], ["STOOL_CULTURE", "confirm", "Shigella"]],
  },
  {
    id: "cholera",
    name: "Cholera (notifiable)",
    icd11: { code: "1A00", title: "Cholera" },
    prior: 0.2,
    features: [["rice_water_stool", 4], ["diarrhoea", 2], ["vomiting", 1.5], ["dehydration", 2.5], ["unsafe_water", 2], ["fever", -1], ["bloody_stool", -2]],
    requiresAny: ["rice_water_stool"],
    redFlags: ["dehydration", "v_hypotension"],
    investigations: [["STOOL_CULTURE", "confirm", "Notify the district surveillance focal person"]],
    pearl: "Notifiable: report within 24 hours (IDSR).",
    urgentIfRedFlag: true,
  },
  {
    id: "pud",
    name: "Peptic ulcer disease / gastritis",
    icd11: { code: "DA61", title: "Peptic ulcer, site unspecified" },
    icd11Alternatives: [{ code: "DA42.Z", title: "Gastritis, unspecified", when: "if there is no ulcer" }],
    prior: 2,
    features: [["epigastric_pain", 3.5], ["epigastric_tenderness", 2], ["nausea", 1], ["heartburn", 1], ["nsaid_use", 2], ["vomiting", 0.5], ["fever", -1]],
    requiresAny: ["epigastric_pain", "epigastric_tenderness"],
    redFlags: ["guarding", "pallor", "v_hypotension"],
    investigations: [["HB", "severity", "Occult bleeding"], ["STOOL", "confirm", "H. pylori stool antigen where available"]],
    pearl: "Black stools, vomiting blood or sudden severe pain: refer.",
  },
  {
    id: "gerd",
    name: "Gastro-oesophageal reflux",
    icd11: { code: "DA22.Z", title: "Gastro-oesophageal reflux disease, unspecified" },
    prior: 1,
    features: [["heartburn", 4], ["epigastric_pain", 1], ["chest_pain", 0.5], ["cough", 0.3]],
    requiresAny: ["heartburn"],
    investigations: [],
  },
  {
    id: "appendicitis",
    name: "Acute appendicitis",
    icd11: { code: "DB10.Z", title: "Appendicitis, unspecified" },
    prior: 0.5,
    features: [["rlq_pain", 4], ["rlq_tenderness", 4], ["guarding", 2], ["abdominal_pain", 1], ["anorexia", 1.5], ["nausea", 1], ["vomiting", 1], ["fever", 1], ["diarrhoea", -1]],
    requiresAny: ["rlq_pain", "rlq_tenderness"],
    redFlags: ["guarding", "v_hypotension"],
    investigations: [["FBC", "confirm", "Leucocytosis"], ["ABD_US", "confirm", "Inflamed appendix"], ["HCG", "exclude", "Exclude ectopic in women"]],
    pearl: "Surgical: refer early. Do not wait for the white count.",
    urgentIfRedFlag: true,
  },
  {
    id: "pid",
    name: "Pelvic inflammatory disease",
    icd11: { code: "GA05.Z", title: "Female pelvic inflammatory diseases, unspecified" },
    prior: 1,
    applies: (c) => isFemale(c),
    features: [["suprapubic_pain", 2.5], ["vaginal_discharge", 3], ["cervical_motion_tenderness", 4], ["fever", 1], ["new_sexual_partner", 1.5], ["dysuria", 0.5], ["missed_period", -1.5]],
    requiresAny: ["vaginal_discharge", "cervical_motion_tenderness", "suprapubic_pain"],
    investigations: [["HCG", "exclude", "Exclude pregnancy (ectopic)"], ["HVS", "confirm", "Gonorrhoea, chlamydia"], ["HIV", "severity", "Offer"], ["RPR", "severity", "Offer"]],
  },
  {
    id: "ectopic",
    name: "Ectopic pregnancy",
    icd11: { code: "JA01.Z", title: "Ectopic pregnancy, unspecified" },
    prior: 0.4,
    applies: (c) => childBearing(c),
    features: [["missed_period", 3.5], ["suprapubic_pain", 2.5], ["pv_bleeding", 2.5], ["abdominal_pain", 1], ["v_hypotension", 2], ["v_tachycardia", 1.5], ["pallor", 1.5], ["guarding", 1]],
    requiresAny: ["missed_period", "pv_bleeding"],
    redFlags: ["v_hypotension", "v_tachycardia", "guarding"],
    investigations: [["HCG", "confirm", "Positive in all ectopics"], ["PELVIC_US", "confirm", "Empty uterus, adnexal mass, free fluid"], ["HB", "severity", "Blood loss"]],
    pearl: "Pain plus missed period plus shock is a ruptured ectopic until proven otherwise.",
    urgentIfRedFlag: true,
  },
  {
    id: "preeclampsia",
    name: "Pre-eclampsia",
    icd11: { code: "JA24.Z", title: "Pre-eclampsia, unspecified" },
    prior: 0.5,
    applies: (c) => c.pregnant === true,
    features: [["v_bp_high", 4], ["v_bp_crisis", 2], ["headache", 1.5], ["visual_disturbance", 2], ["epigastric_pain", 1.5], ["oedema", 1], ["convulsions", 2]],
    requiresAny: ["v_bp_high", "v_bp_crisis"],
    redFlags: ["v_bp_crisis", "convulsions", "visual_disturbance", "epigastric_pain"],
    investigations: [["URINE_PROTEIN", "confirm", "Proteinuria"], ["CREA", "severity", "Renal involvement"], ["ALT", "severity", "Liver involvement"], ["FBC", "severity", "Platelets (HELLP)"]],
    pearl: "Convulsions in pregnancy: magnesium sulphate and deliver.",
    urgentIfRedFlag: true,
  },
  {
    id: "hypertension",
    name: "Hypertension",
    icd11: { code: "BA00.Z", title: "Essential hypertension, unspecified" },
    prior: 1.5,
    applies: (c) => c.pregnant !== true,
    features: [["v_bp_high", 4], ["known_hypertension", 3], ["headache", 0.5], ["palpitations", 0.5], ["visual_disturbance", 0.5]],
    requiresAny: ["v_bp_high", "known_hypertension"],
    investigations: [["CREA", "severity", "Baseline kidney function"], ["URINE", "severity", "Proteinuria"], ["GLU", "severity", "Screen for diabetes"], ["ECG", "severity", "Left ventricular hypertrophy"]],
    pearl: "Confirm with two readings on separate visits before starting lifelong treatment.",
  },
  {
    id: "hypertensive_crisis",
    name: "Hypertensive crisis",
    icd11: { code: "BA03", title: "Hypertensive crisis" },
    prior: 0.3,
    applies: (c) => c.pregnant !== true,
    features: [["v_bp_crisis", 5], ["headache", 1], ["chest_pain", 1.5], ["dyspnoea", 1], ["confusion", 2], ["visual_disturbance", 1.5]],
    requiresAny: ["v_bp_crisis"],
    redFlags: ["chest_pain", "confusion", "dyspnoea", "visual_disturbance"],
    investigations: [["CREA", "severity", "Acute kidney injury"], ["ECG", "severity", "Ischaemia"], ["URINE", "severity", "Haematuria / protein"]],
    pearl: "With organ damage it is an emergency: lower BP gradually and admit.",
    urgentIfRedFlag: true,
  },
  {
    id: "diabetes",
    name: "Type 2 diabetes mellitus",
    icd11: { code: "5A11", title: "Type 2 diabetes mellitus" },
    icd11Alternatives: [{ code: "5A10", title: "Type 1 diabetes mellitus", when: "young, thin, or ketotic at diagnosis" }],
    prior: 1,
    features: [["polyuria", 3], ["polydipsia", 3], ["weight_loss", 1], ["fatigue", 0.5], ["visual_disturbance", 0.5], ["known_diabetes", 3]],
    requiresAny: ["polyuria", "polydipsia", "known_diabetes"],
    investigations: [["GLU", "confirm", "Random 11.1 mmol/L or more, or fasting 7.0 or more"], ["HBA1C", "confirm", "6.5% or more"], ["URINE", "severity", "Glucose, ketones, protein"], ["CREA", "severity", "Kidney function"]],
  },
  {
    id: "dka",
    name: "Diabetic ketoacidosis",
    icd11: { code: "5A22.0", title: "Diabetic ketoacidosis without coma" },
    icd11Alternatives: [{ code: "5A22.3", title: "Diabetic ketoacidosis with coma", when: "if unconscious" }],
    prior: 0.3,
    features: [["known_diabetes", 2], ["polyuria", 1.5], ["polydipsia", 1.5], ["vomiting", 1.5], ["abdominal_pain", 1.5], ["deep_breathing", 4], ["dehydration", 2], ["confusion", 1.5], ["v_tachycardia", 1]],
    requiresAny: ["deep_breathing", "known_diabetes", "polyuria"],
    redFlags: ["confusion", "v_hypotension", "deep_breathing"],
    investigations: [["GLU", "confirm", "Usually above 13.9 mmol/L"], ["URINE_KETONES", "confirm", "Ketonuria"], ["K", "severity", "Before insulin"], ["NA", "severity", "Electrolytes"], ["CREA", "severity", "Kidney function"]],
    pearl: "Fluids first, then insulin. Check potassium before insulin.",
    urgentIfRedFlag: true,
  },
  {
    id: "meningitis",
    name: "Bacterial meningitis",
    icd11: { code: "1D01.0Z", title: "Bacterial meningitis, unspecified" },
    prior: 0.3,
    features: [["neck_stiffness", 4.5], ["fever", 2], ["v_fever", 1], ["headache", 2], ["photophobia", 2.5], ["confusion", 2.5], ["convulsions", 1.5], ["vomiting", 1], ["rash", 1]],
    requiresAny: ["neck_stiffness", "photophobia", "confusion"],
    redFlags: ["neck_stiffness", "confusion", "convulsions"],
    investigations: [["CSF", "confirm", "Cell count, Gram stain, culture, CrAg if HIV positive"], ["BLOOD_CULTURE", "confirm", "Before antibiotics if no delay"], ["MRDT", "exclude", "Cerebral malaria"], ["GLU", "severity", "Hypoglycaemia"]],
    pearl: "Do not delay antibiotics for the lumbar puncture.",
    urgentIfRedFlag: true,
  },
  {
    id: "sepsis",
    name: "Sepsis",
    icd11: { code: "1G40", title: "Sepsis without septic shock" },
    icd11Alternatives: [{ code: "1G41", title: "Sepsis with septic shock", when: "if hypotension persists after fluids" }],
    prior: 0.5,
    features: [["fever", 1.5], ["v_fever", 1], ["v_hypothermia", 2], ["v_tachycardia", 2], ["v_tachypnoea", 2], ["v_hypotension", 3.5], ["confusion", 2.5], ["chills", 1]],
    requiresAny: ["v_hypotension", "confusion", "v_hypothermia"],
    redFlags: ["v_hypotension", "confusion"],
    investigations: [["BLOOD_CULTURE", "confirm", "Before antibiotics"], ["FBC", "severity", "White cells"], ["CREA", "severity", "Organ dysfunction"], ["MRDT", "exclude", "Severe malaria"], ["GLU", "severity", "Hypoglycaemia"]],
    pearl: "Antibiotics within the hour, fluids, find the source.",
    urgentIfRedFlag: true,
  },
  {
    id: "anaemia",
    name: "Iron deficiency anaemia",
    icd11: { code: "3A00.Z", title: "Iron deficiency anaemia, unspecified" },
    prior: 1,
    features: [["pallor", 3.5], ["fatigue", 2], ["palpitations", 1], ["dyspnoea", 1], ["v_tachycardia", 0.5], ["fever", -0.5]],
    requiresAny: ["pallor"],
    redFlags: ["dyspnoea", "v_hypotension"],
    investigations: [["HB", "confirm", "Severity"], ["FBC", "confirm", "Low MCV"], ["STOOL", "confirm", "Hookworm"], ["MRDT", "exclude", "Malaria causes anaemia"]],
  },
  {
    id: "sickle_crisis",
    name: "Sickle cell crisis",
    icd11: { code: "3A51.2", title: "Sickle cell disease with crisis" },
    prior: 0.3,
    features: [["known_sickle_cell", 4], ["bone_pain", 3.5], ["fever", 1], ["pallor", 1.5], ["jaundice", 1.5], ["chest_pain", 1], ["dyspnoea", 1]],
    requiresAny: ["known_sickle_cell", "bone_pain"],
    redFlags: ["chest_pain", "dyspnoea", "v_hypoxia", "confusion"],
    investigations: [["HB", "severity", "Compare with steady-state Hb"], ["SICKLING", "confirm", "If status unknown"], ["MRDT", "exclude", "Malaria triggers crises"], ["CXR", "severity", "Acute chest syndrome"]],
    pearl: "Chest pain, low SpO₂ or new infiltrate: acute chest syndrome.",
  },
  {
    id: "brucellosis",
    name: "Brucellosis",
    icd11: { code: "1B95", title: "Brucellosis" },
    prior: 0.4,
    features: [["back_joint_pain_chronic", 3], ["fever", 1.5], ["myalgia", 2], ["night_sweats", 1.5], ["raw_milk", 3], ["fatigue", 1], ["hepatomegaly", 1], ["splenomegaly", 1]],
    requiresAny: ["raw_milk", "back_joint_pain_chronic"],
    investigations: [["BRUCELLA", "confirm", "Serology"], ["BLOOD_CULTURE", "confirm", "Prolonged incubation"], ["MRDT", "exclude", "Malaria"]],
  },
  {
    id: "cellulitis",
    name: "Cellulitis",
    icd11: { code: "1B70.Z", title: "Bacterial cellulitis or lymphangitis due to unspecified bacterium" },
    prior: 1,
    features: [["skin_red_swollen", 4.5], ["fever", 1], ["lymphadenopathy", 0.5], ["known_diabetes", 0.5]],
    requiresAny: ["skin_red_swollen"],
    redFlags: ["v_hypotension", "confusion"],
    investigations: [["GLU", "severity", "Undiagnosed diabetes"], ["FBC", "severity", "If systemically unwell"]],
  },
  {
    id: "scabies",
    name: "Scabies",
    icd11: { code: "1G04.0", title: "Classical scabies" },
    prior: 1,
    features: [["itch", 3], ["itch_worse_night", 3], ["rash", 1.5]],
    requiresAny: ["itch", "itch_worse_night"],
    investigations: [["SKIN_SCRAPING", "confirm", "Rarely needed"]],
    pearl: "Treat all household contacts at the same time.",
  },
  {
    id: "gonorrhoea",
    name: "Urethritis / gonorrhoea",
    icd11: { code: "1A70.0Z", title: "Gonococcal infection of lower genitourinary tract without periurethral or accessory gland abscess, unspecified" },
    icd11Alternatives: [{ code: "GC02.Z", title: "Urethritis and urethral syndrome, unspecified", when: "if the organism is not known" }],
    prior: 1,
    features: [["urethral_discharge", 4.5], ["dysuria", 2], ["new_sexual_partner", 2], ["vaginal_discharge", 1.5]],
    requiresAny: ["urethral_discharge", "vaginal_discharge"],
    investigations: [["URETHRAL_SWAB", "confirm", "Gram-negative diplococci"], ["HIV", "severity", "Offer"], ["RPR", "severity", "Offer"]],
    pearl: "Treat the partner too.",
  },
  {
    id: "heart_failure",
    name: "Congestive heart failure",
    icd11: { code: "BD10", title: "Congestive heart failure" },
    prior: 0.5,
    features: [["dyspnoea", 2.5], ["orthopnoea", 3.5], ["oedema", 2.5], ["raised_jvp", 3.5], ["crepitations", 1.5], ["fatigue", 1], ["palpitations", 1], ["known_hypertension", 1], ["v_tachycardia", 0.5]],
    requiresAny: ["orthopnoea", "raised_jvp", "oedema"],
    redFlags: ["v_hypoxia", "v_hypotension", "chest_pain"],
    investigations: [["ECHO", "confirm", "Ejection fraction, valves"], ["CXR", "confirm", "Cardiomegaly, pulmonary oedema"], ["ECG", "confirm", "Rhythm, ischaemia"], ["CREA", "severity", "Before diuretics"], ["HB", "severity", "Anaemia worsens it"]],
  },
  {
    id: "migraine",
    name: "Migraine",
    icd11: { code: "8A80.0", title: "Migraine without aura" },
    prior: 0.8,
    features: [["headache", 2], ["unilateral_headache", 3.5], ["photophobia", 1.5], ["nausea", 1.5], ["vomiting", 0.5], ["fever", -2], ["neck_stiffness", -3]],
    requiresAny: ["unilateral_headache"],
    investigations: [],
    pearl: "A first, sudden or worst-ever headache needs urgent review.",
  },
  {
    id: "tension_headache",
    name: "Tension-type headache",
    icd11: { code: "8A81.Z", title: "Tension-type headache, unspecified" },
    prior: 1,
    features: [["headache", 2], ["band_headache", 3.5], ["fever", -2], ["neck_stiffness", -3], ["vomiting", -1]],
    requiresAny: ["band_headache"],
    investigations: [],
  },
  {
    id: "conjunctivitis",
    name: "Conjunctivitis",
    icd11: { code: "9A60.Z", title: "Conjunctivitis, unspecified" },
    prior: 1,
    features: [["red_eye", 4]],
    requiresAny: ["red_eye"],
    investigations: [],
    pearl: "Pain, reduced vision or photophobia is not simple conjunctivitis: refer.",
  },
  {
    id: "influenza",
    name: "Influenza-like illness",
    icd11: { code: "1E32", title: "Influenza, virus not identified" },
    prior: 1,
    features: [["fever", 2], ["v_fever", 1], ["cough", 2], ["myalgia", 2], ["headache", 1], ["sore_throat", 1], ["runny_nose", 1], ["fatigue", 1]],
    requiresAny: ["cough", "sore_throat"],
    investigations: [["MRDT", "exclude", "Malaria"]],
  },
  {
    id: "hiv",
    name: "HIV infection (test and stage)",
    icd11: { code: "1C62", title: "Human immunodeficiency virus disease without mention of tuberculosis or malaria" },
    prior: 0.5,
    features: [["weight_loss", 2], ["oral_thrush", 3.5], ["lymphadenopathy", 1.5], ["night_sweats", 1], ["diarrhoea", 0.5], ["new_sexual_partner", 1.5], ["known_hiv", 4]],
    requiresAny: ["oral_thrush", "known_hiv", "weight_loss"],
    investigations: [["HIV", "confirm", "Rapid test per national algorithm"], ["GENEXPERT", "exclude", "Screen for TB"]],
    pearl: "Code the WHO clinical stage (1C62.0-1C62.3) once known.",
  },
  {
    id: "dehydration",
    name: "Dehydration",
    icd11: { code: "5C70.0", title: "Dehydration" },
    prior: 0.5,
    features: [["dehydration", 4], ["vomiting", 1], ["diarrhoea", 1], ["v_tachycardia", 1], ["v_hypotension", 1.5]],
    requiresAny: ["dehydration"],
    redFlags: ["v_hypotension", "confusion"],
    investigations: [["NA", "severity", "Electrolytes"], ["K", "severity", "Electrolytes"], ["CREA", "severity", "Kidney injury"]],
  },
]

// ---------------------------------------------------------------------------
// Vitals and free text into findings
// ---------------------------------------------------------------------------

export type Vitals = {
  temperatureC?: number | null
  heartRate?: number | null
  respiratoryRate?: number | null
  spo2?: number | null
  bpSystolic?: number | null
  bpDiastolic?: number | null
}

/** WHO IMCI fast-breathing cut-offs for children, 20/min for adults. */
function fastBreathing(rr: number, ageYears?: number | null): boolean {
  if (ageYears == null || ageYears >= 12) return rr > 20
  if (ageYears < 1) return rr >= 50
  if (ageYears < 5) return rr >= 40
  return rr > 30
}

function fastHeart(hr: number, ageYears?: number | null): boolean {
  if (ageYears == null || ageYears >= 12) return hr > 100
  if (ageYears < 1) return hr > 160
  if (ageYears < 5) return hr > 140
  return hr > 120
}

export function vitalFindings(v: Vitals | null | undefined, ctx: PatientContext = {}): FindingMap {
  const out: FindingMap = {}
  if (!v) return out
  const t = num(v.temperatureC)
  if (t != null) {
    if (t >= 37.5) out.v_fever = "present"
    else out.v_fever = "absent"
    if (t >= 39) out.v_high_fever = "present"
    if (t < 36) out.v_hypothermia = "present"
  }
  const hr = num(v.heartRate)
  if (hr != null) out.v_tachycardia = fastHeart(hr, ctx.ageYears) ? "present" : "absent"
  const rr = num(v.respiratoryRate)
  if (rr != null) out.v_tachypnoea = fastBreathing(rr, ctx.ageYears) ? "present" : "absent"
  const sp = num(v.spo2)
  if (sp != null) out.v_hypoxia = sp < 94 ? "present" : "absent"
  const sbp = num(v.bpSystolic)
  const dbp = num(v.bpDiastolic)
  if (sbp != null) {
    out.v_hypotension = sbp < 90 ? "present" : "absent"
    const high = sbp >= 140 || (dbp != null && dbp >= 90)
    out.v_bp_high = high ? "present" : "absent"
    out.v_bp_crisis = sbp >= 180 || (dbp != null && dbp >= 120) ? "present" : "absent"
  }
  return out
}

function num(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN
  return Number.isFinite(n) ? n : null
}

const NEGATORS = ["no ", "not ", "denies ", "denied ", "without ", "nil ", "negative for ", "absence of ", "never "]

type SynonymEntry = { id: FindingId; phrase: string }
let synonymIndex: SynonymEntry[] | null = null
function synonyms(): SynonymEntry[] {
  if (synonymIndex) return synonymIndex
  const list: SynonymEntry[] = []
  for (const id of FINDING_IDS) {
    const def = FINDINGS[id] as FindingDef
    for (const phrase of def.synonyms ?? []) list.push({ id, phrase })
  }
  // Longer phrases first so "lower abdominal pain" wins over "abdominal pain".
  list.sort((a, b) => b.phrase.length - a.phrase.length)
  synonymIndex = list
  return list
}

/**
 * Findings mentioned in a free-text note. A phrase in a clause that starts
 * with or contains a negator before it ("no cough", "denies fever") counts
 * as a pertinent negative.
 */
export function extractFindings(text: string | null | undefined): FindingMap {
  const out: FindingMap = {}
  const src = ` ${String(text ?? "").toLowerCase().slice(0, 20000)} `
  if (!src.trim()) return out
  const clauses = src.split(/[.;\n]|,\s*(?:but|and)?\s*/)
  for (const raw of clauses) {
    let clause = ` ${raw.replace(/[^a-z0-9 /-]+/g, " ").replace(/\s+/g, " ").trim()} `
    for (const { id, phrase } of synonyms()) {
      const needle = ` ${phrase} `
      const at = clause.indexOf(needle)
      if (at < 0) continue
      const before = clause.slice(0, at + 1)
      const negated = NEGATORS.some((n) => before.includes(` ${n}`) || before.startsWith(n))
      // Present beats absent if the note says both in different clauses.
      if (negated) {
        if (out[id] !== "present") out[id] = "absent"
      } else {
        out[id] = "present"
      }
      // Remove the phrase so a shorter synonym inside it does not match again.
      clause = clause.slice(0, at) + " ".repeat(needle.length) + clause.slice(at + needle.length)
    }
  }
  return out
}

/** Typed / tapped findings win over text, text wins over vitals-derived. */
export function mergeFindings(...maps: (FindingMap | null | undefined)[]): FindingMap {
  const out: FindingMap = {}
  for (const m of maps) {
    if (!m) continue
    for (const [k, v] of Object.entries(m) as [FindingId, FindingState][]) {
      if (!(k in out)) out[k] = v
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type Likelihood = "high" | "moderate" | "low"

export type DifferentialInvestigation = InvestigationDef & { purpose: InvestigationPurpose; why: string }

export type Differential = {
  id: string
  name: string
  icd11: { code: string; title: string }
  icd11Alternatives: { code: string; title: string; when: string }[]
  score: number
  /** Share of the total across the listed diagnoses, for the bar. Not a probability. */
  relative: number
  likelihood: Likelihood
  supporting: { id: FindingId; label: string }[]
  against: { id: FindingId; label: string }[]
  askNext: { id: FindingId; label: string }[]
  redFlags: { id: FindingId; label: string }[]
  urgent: boolean
  investigations: DifferentialInvestigation[]
  pearl: string | null
}

export type DifferentialResult = {
  engine: typeof DIFFERENTIAL_ENGINE_VERSION
  differentials: Differential[]
  /** Unknown findings that would separate the top diagnoses most. */
  askNext: { id: FindingId; label: string; system: BodySystem }[]
  /** Red flags present, whatever the diagnosis. */
  dangerSigns: { id: FindingId; label: string }[]
  findingCount: number
}

const GLOBAL_DANGER: FindingId[] = ["confusion", "convulsions", "prostration", "v_hypoxia", "v_hypotension", "v_bp_crisis", "neck_stiffness", "guarding", "chest_indrawing", "deep_breathing"]

/** A qualitative result for one of the investigations above (e.g. MRDT negative). */
export type InvestigationOutcome = { code: InvestigationCode | string; positive: boolean; label?: string }

const POSITIVE_TEXT = /\b(positive|reactive|detected|seen|present|growth)\b/i
const NEGATIVE_TEXT = /\b(negative|non[- ]?reactive|not detected|none seen|no growth|not seen|absent|nil)\b|\bno\b[^.;]*\b(seen|detected|found|isolated)\b/i

/**
 * Reads a free-text lab result as positive / negative, or null when it is a
 * number or unclear. Negative wording wins ("no parasites seen").
 */
export function interpretQualitativeResult(value: unknown): boolean | null {
  // Lab result text is short; the cap keeps both patterns below linear-time.
  const text = String(value ?? "").trim().slice(0, 200)
  // A number with an optional unit ("9.1", "<5 mg/L", "12.5 g/dL"). The
  // character classes do not overlap, so this cannot backtrack.
  if (!text || /^[<>]?\s*-?[\d.]+\s*[a-z/%*^]*$/i.test(text)) return null
  if (NEGATIVE_TEXT.test(text)) return false
  if (POSITIVE_TEXT.test(text)) return true
  return null
}

/** Match a lab order to an investigation code by LOINC, catalogue code or name. */
export function investigationCodeFor(order: { loinc_code?: string | null; code?: string | null; test_name?: string | null }): InvestigationCode | null {
  const entries = Object.entries(INVESTIGATIONS) as [InvestigationCode, InvestigationDef][]
  const loinc = order.loinc_code?.trim()
  if (loinc) {
    const hit = entries.find(([, d]) => d.loinc === loinc)
    if (hit) return hit[0]
  }
  const code = order.code?.trim().toUpperCase()
  if (code && code in INVESTIGATIONS) return code as InvestigationCode
  const name = order.test_name?.trim().toLowerCase()
  if (name) {
    const hit = entries.find(([, d]) => d.name.toLowerCase() === name)
    if (hit) return hit[0]
    if (/malaria/.test(name) && /rdt|antigen/.test(name)) return "MRDT"
    if (/malaria/.test(name) && /smear|film|bs\b/.test(name)) return "BS"
    if (/genexpert|xpert/.test(name)) return "GENEXPERT"
    if (/hiv/.test(name)) return "HIV"
    if (/hcg|pregnancy/.test(name)) return "HCG"
  }
  return null
}

export function rankDifferentials(
  findings: FindingMap,
  ctx: PatientContext = {},
  limit = 8,
  outcomes: InvestigationOutcome[] = [],
): DifferentialResult {
  const present = (f: FindingId) => findings[f] === "present"
  const absent = (f: FindingId) => findings[f] === "absent"
  const scored: Omit<Differential, "relative">[] = []

  for (const c of CONDITIONS) {
    if (c.applies && !c.applies(ctx)) continue
    const confirmedByTest = c.investigations.some(
      ([code, purpose]) => purpose === "confirm" && outcomes.some((o) => o.positive && String(o.code).toUpperCase() === code),
    )
    if (!c.requiresAny.some(present) && !confirmedByTest) continue
    let score = c.prior
    const supporting: Differential["supporting"] = []
    const against: Differential["against"] = []
    const askNext: Differential["askNext"] = []
    for (const [f, w] of c.features) {
      if (present(f)) {
        score += w
        if (w > 0) supporting.push({ id: f, label: findingLabel(f) })
        else against.push({ id: f, label: findingLabel(f) })
      } else if (absent(f)) {
        // A pertinent negative counts against a feature that should be there.
        if (w >= 2) {
          score -= w * 0.6
          against.push({ id: f, label: `No ${findingLabel(f).toLowerCase()}` })
        }
      } else if (w >= 2 && !FINDINGS[f].group.startsWith("vital")) {
        askNext.push({ id: f, label: findingLabel(f) })
      }
    }
    // A confirming test that came back negative counts strongly against;
    // a positive one strongly for. Tests ordered only to exclude or stage
    // something else are ignored here.
    for (const [code, purpose] of c.investigations) {
      if (purpose !== "confirm") continue
      const o = outcomes.find((x) => String(x.code).toUpperCase() === code)
      if (!o) continue
      const name = INVESTIGATIONS[code].name
      if (o.positive) {
        score += 5
        supporting.unshift({ id: c.requiresAny[0]!, label: `${name} positive` })
      } else {
        score -= 6
        against.unshift({ id: c.requiresAny[0]!, label: `${name} negative` })
      }
    }
    const redFlags = (c.redFlags ?? []).filter(present).map((id) => ({ id, label: findingLabel(id) }))
    scored.push({
      id: c.id,
      name: c.name,
      icd11: c.icd11,
      icd11Alternatives: c.icd11Alternatives ?? [],
      score: Math.round(score * 10) / 10,
      likelihood: score >= 8 ? "high" : score >= 5 ? "moderate" : "low",
      supporting,
      against,
      askNext: askNext.slice(0, 4),
      redFlags,
      urgent: Boolean(c.urgentIfRedFlag && redFlags.length > 0),
      investigations: c.investigations.map(([code, purpose, why]) => ({ ...INVESTIGATIONS[code], purpose, why })),
      pearl: c.pearl ?? null,
    })
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  const top = scored.filter((d) => d.score > 0).slice(0, Math.max(1, limit))
  const weights = top.map((d) => Math.exp(d.score / 2))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const differentials: Differential[] = top.map((d, i) => ({ ...d, relative: Math.round(((weights[i] ?? 0) / total) * 100) / 100 }))

  // Questions that split the top diagnoses: features cardinal for some of
  // the top five and not yet answered, weighted by how likely each one is.
  const lead = differentials.slice(0, 5)
  const value = new Map<FindingId, number>()
  for (const d of lead) {
    const def = CONDITIONS.find((c) => c.id === d.id)!
    for (const [f, w] of def.features) {
      if (findings[f] || FINDINGS[f].group === "vital" || Math.abs(w) < 1.5) continue
      value.set(f, (value.get(f) ?? 0) + Math.abs(w) * d.relative)
    }
  }
  const askNext = [...value.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => ({ id, label: findingLabel(id), system: FINDINGS[id].system }))

  const dangerSigns = GLOBAL_DANGER.filter(present).map((id) => ({ id, label: findingLabel(id) }))
  const findingCount = Object.values(findings).filter((v) => v === "present").length

  return { engine: DIFFERENTIAL_ENGINE_VERSION, differentials, askNext, dangerSigns, findingCount }
}

/** Everything from the screen in one call. */
export function differentialFromConsultation(input: {
  text?: string | null
  tapped?: FindingMap | null
  vitals?: Vitals | null
  context?: PatientContext
  limit?: number
  outcomes?: InvestigationOutcome[]
}): DifferentialResult & { findings: FindingMap } {
  const ctx = input.context ?? {}
  const findings = mergeFindings(input.tapped, extractFindings(input.text), vitalFindings(input.vitals, ctx))
  return { ...rankDifferentials(findings, ctx, input.limit, input.outcomes ?? []), findings }
}
