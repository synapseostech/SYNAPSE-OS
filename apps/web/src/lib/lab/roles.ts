/**
 * Role groups for the lab screens that still gate by role rather than by a
 * `lab.*` capability (instrument set-up, analyser staging, mappings, critical
 * acknowledgement). Before this, those routes named `lab_manager` — a role
 * nothing provisions — and left out `lab_admin`, the role a standalone
 * laboratory's administrator is given, so a new lab could not set up its own
 * analysers.
 */

/** Run the lab: devices, mappings, catalogue. */
export const LAB_MANAGER_ROLES = new Set(['lab_admin', 'lab_manager', 'lab_supervisor', 'hospital_admin'])

/** Senior bench staff: review analyser results, acknowledge critical values. */
export const LAB_SENIOR_ROLES = new Set([...LAB_MANAGER_ROLES, 'lab_scientist'])

/** Anyone working in the lab. */
export const LAB_STAFF_ROLES = new Set([...LAB_SENIOR_ROLES, 'lab_tech', 'lab_technician'])

/** Clinicians who receive results. */
export const LAB_CLINICIAN_ROLES = new Set(['doctor', 'clinical_officer'])
