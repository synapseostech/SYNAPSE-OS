// Shared role taxonomy for the mobile app.
// Mirrors the web role groupings (see apps/web/src/lib/dashboard/resolver.ts) so the
// mobile dashboards stay consistent with the web portal. The /api/mobile/dashboard
// endpoint computes the same `DashboardKind` server-side and returns it authoritatively;
// these helpers are the client-side fallback + labels.

export type DashboardKind =
  | 'patient'
  | 'clinician'
  | 'nurse'
  | 'pharmacy'
  | 'lab'
  | 'reception'
  | 'billing'
  | 'admin'
  | 'generic'

const ROLE_KIND: Record<string, DashboardKind> = {
  // Patient
  patient: 'patient',

  // Clinicians (prescribers)
  doctor: 'clinician',
  independent_doctor: 'clinician',
  clinician: 'clinician',
  clinical_officer: 'clinician',
  specialist: 'clinician',
  surgeon: 'clinician',
  anaesthetist: 'clinician',
  intensivist: 'clinician',
  cardiologist: 'clinician',
  oncologist: 'clinician',
  psychiatrist: 'clinician',
  nephrologist: 'clinician',
  art_clinician: 'clinician',
  obstetrician: 'clinician',
  paediatrician: 'clinician',
  radiologist: 'clinician',
  radiographer: 'clinician',

  // Nursing / community
  nurse: 'nurse',
  theatre_nurse: 'nurse',
  icu_nurse: 'nurse',
  hiv_counselor: 'nurse',
  chw: 'nurse',
  social_worker: 'nurse',

  // Pharmacy
  pharmacist: 'pharmacy',
  pharmacy_admin: 'pharmacy',
  pharmacy_store_manager: 'pharmacy',
  pharmacy_cashier: 'pharmacy',
  cashier: 'pharmacy',
  // Live DB profiles.role check permits pharmacy_staff / pharmacy_ceo (not cashier);
  // these are the real cashier/owner equivalents at a pharmacy tenant.
  pharmacy_staff: 'pharmacy',
  pharmacy_ceo: 'pharmacy',

  // Lab
  lab_tech: 'lab',
  lab_technician: 'lab',
  lab_scientist: 'lab',
  lab_supervisor: 'lab',
  lab_manager: 'lab',
  // A standalone laboratory's administrator works the bench too.
  lab_admin: 'lab',

  // Front desk
  receptionist: 'reception',

  // Billing / insurance
  billing_officer: 'billing',
  claims_officer: 'billing',
  insurance_officer: 'billing',

  // Admin
  admin: 'admin',
  hospital_admin: 'admin',
  facility_admin: 'admin',
  superadmin: 'admin',
  super_admin: 'admin',
  overall_admin: 'admin',
  platform_admin: 'admin',
}

export function dashboardKindForRole(role: string | undefined | null): DashboardKind {
  if (!role) return 'generic'
  return ROLE_KIND[role] ?? 'generic'
}

/** Clinical roles see the Patients tab and can open patient charts. */
export function isClinicalRole(role: string | undefined | null): boolean {
  const kind = dashboardKindForRole(role)
  return kind === 'clinician' || kind === 'nurse' || kind === 'reception' || kind === 'admin' || kind === 'lab'
}

export function formatRole(role: string | undefined | null): string {
  if (!role) return 'User'
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
