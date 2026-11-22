import { z } from 'zod'
import { LAB_SECTIONS } from './sections'

// No defaults on the shared shape: a PATCH must change only what it names.
const catalogFields = {
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/),
  loincCode: z.string().trim().min(1).max(40).nullable(),
  name: z.string().trim().min(2).max(200),
  section: z.enum(LAB_SECTIONS),
  specimenType: z.string().trim().min(2).max(60),
  container: z.string().trim().max(60).nullable(),
  unit: z.string().trim().max(30).nullable(),
  price: z.number().nonnegative().max(100_000_000).nullable(),
  currency: z.string().trim().length(3),
  turnaroundMinutes: z.number().int().positive().max(60 * 24 * 60).nullable(),
  isActive: z.boolean(),
  /** A panel's analytes (FBC, LFT…). Empty for an ordinary test. */
  components: z
    .array(z.object({
      loinc: z.string().trim().regex(/^\d{1,7}-\d$/, 'LOINC looks like 718-7'),
      name: z.string().trim().min(1).max(120),
      unit: z.string().trim().max(30).nullable().optional(),
      section: z.enum(LAB_SECTIONS).optional(),
    }).strict())
    .max(40)
    .refine((list) => new Set(list.map((c) => c.loinc)).size === list.length, 'Each component needs its own LOINC'),
}

export const labCatalogEntrySchema = z.object({
  ...catalogFields,
  loincCode: catalogFields.loincCode.optional(),
  specimenType: catalogFields.specimenType.default('blood'),
  container: catalogFields.container.optional(),
  unit: catalogFields.unit.optional(),
  price: catalogFields.price.optional(),
  currency: catalogFields.currency.default('UGX'),
  turnaroundMinutes: catalogFields.turnaroundMinutes.optional(),
  isActive: catalogFields.isActive.default(true),
  components: catalogFields.components.default([]),
})

export const labCatalogPatchSchema = z.object(catalogFields).partial().strict()

export type LabCatalogEntryInput = z.infer<typeof labCatalogEntrySchema>

export function catalogInputToRow(input: Partial<LabCatalogEntryInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  if (input.code !== undefined) row.code = input.code.toUpperCase()
  if (input.loincCode !== undefined) row.loinc_code = input.loincCode || null
  if (input.name !== undefined) row.name = input.name
  if (input.section !== undefined) row.section = input.section
  if (input.specimenType !== undefined) row.specimen_type = input.specimenType
  if (input.container !== undefined) row.container = input.container || null
  if (input.unit !== undefined) row.unit = input.unit || null
  if (input.price !== undefined) row.price = input.price
  if (input.currency !== undefined) row.currency = input.currency.toUpperCase()
  if (input.turnaroundMinutes !== undefined) row.turnaround_minutes = input.turnaroundMinutes
  if (input.isActive !== undefined) row.is_active = input.isActive
  if (input.components !== undefined) row.components = input.components
  return row
}

export const labReferenceRangeSchema = z.object({
  loincCode: z.string().trim().min(1).max(40),
  testName: z.string().trim().min(2).max(200),
  unit: z.string().trim().min(1).max(30),
  sex: z.enum(['M', 'F']).optional().nullable(),
  ageMinYears: z.number().min(0).max(130).optional().nullable(),
  ageMaxYears: z.number().min(0).max(130).optional().nullable(),
  low: z.number(),
  high: z.number(),
  criticalLow: z.number().optional().nullable(),
  criticalHigh: z.number().optional().nullable(),
}).refine((r) => r.low <= r.high, { message: 'low must not exceed high' })
  .refine((r) => r.criticalLow == null || r.criticalLow <= r.low, { message: 'critical low must be at or below low' })
  .refine((r) => r.criticalHigh == null || r.criticalHigh >= r.high, { message: 'critical high must be at or above high' })
  .refine((r) => r.ageMinYears == null || r.ageMaxYears == null || r.ageMinYears <= r.ageMaxYears, { message: 'age range is reversed' })
