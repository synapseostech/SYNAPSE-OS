/**
 * Commercial catalog entitlements.
 *
 * Source: public plan rows in
 * supabase/migrations/20260922170000_commercial_platform.sql
 * and the module→feature registry used by gateHospitalModule.
 *
 * These keys are what has_feature() must find on plan_features.
 * They are not a grant of every hospital module. IPD, dispensing,
 * radiology, maternity, theatre, emergency, claims and the other
 * registry keys have no commercial mapping and stay unentitled.
 *
 * Pharmacy feature keys are already inserted by that migration.
 * OS / Lab keys are prepared in
 * supabase/migrations/20261029090000_plan_feature_entitlements.sql and take
 * effect once that migration is applied.
 */

/**
 * `dispensing` is the hospital pharmacy point (receive a prescription, dispense,
 * stock decrement, charge capture). It is not the standalone Pharmacy catalog
 * (`pos.sell`, purchasing, suppliers, Tally, pharmacy network).
 * Triage and outpatient vitals ride the `opd` feature. `ipd` stays ungranted.
 */
export const OS_BASIC_FEATURES = ["registration", "opd", "dispensing", "billing", "reports"] as const
export const OS_LAB_ADDON_FEATURES = [...OS_BASIC_FEATURES, "lab"] as const
export const STANDALONE_LAB_FEATURES = ["lab", "registration", "billing", "reports"] as const

/** Already seeded on synapse_pharmacy_annual. Not part of the proposed OS/Lab seed. */
export const PHARMACY_ANNUAL_FEATURES = [
  "pos.sell",
  "inventory.read",
  "inventory.write",
  "receipts.print",
  "billing.view",
  "account.view",
  "data.read",
  "data.export",
  "reports.generate",
  "purchasing.manage",
] as const

export const COMMERCIAL_PLAN_FEATURES: Record<string, readonly string[]> = {
  synapse_os_basic_annual: OS_BASIC_FEATURES,
  synapse_os_lab_addon_annual: OS_LAB_ADDON_FEATURES,
  synapse_lab_annual: STANDALONE_LAB_FEATURES,
  synapse_pharmacy_annual: PHARMACY_ANNUAL_FEATURES,
  // Custom quote. Do not invent a module set.
  synapse_enterprise: [],
}

export function planIncludesFeature(planSlug: string, feature: string): boolean {
  return (COMMERCIAL_PLAN_FEATURES[planSlug] ?? []).includes(feature)
}

/**
 * Which single subscription plan a new facility should receive.
 * tenant_subscriptions is unique per tenant, so an OS + Lab facility
 * points at the add-on plan (which carries OS Basic + lab), not a second row.
 */
export function commercialPlanSlug(input: {
  facilityType?: string | null
  tier?: string | null
  includeLabAddon?: boolean
}): string {
  const type = String(input.facilityType ?? "hospital").toLowerCase()
  if (type === "pharmacy") return "synapse_pharmacy_annual"
  if (type === "laboratory") return "synapse_lab_annual"
  if (input.tier === "enterprise") return "synapse_enterprise"
  if (input.includeLabAddon) return "synapse_os_lab_addon_annual"
  return "synapse_os_basic_annual"
}
