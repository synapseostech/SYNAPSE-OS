/**
 * Private Storage buckets used by the pharmacy surface.
 *
 * The import bucket is written by the Tally flow and cleared by the admin reset.
 * Its name lives here, outside `lib/tally`, so the operating surface can empty a
 * tenant's import files without importing the Tally modules that the AC-9
 * disconnect test keeps out of it (lib/tally/disconnect.test.ts).
 */
export const PHARMACY_IMPORT_BUCKET = "pharmacy-imports"
