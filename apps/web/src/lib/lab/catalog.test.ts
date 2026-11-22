import { describe, expect, it } from 'vitest'
import { catalogInputToRow, labCatalogEntrySchema, labCatalogPatchSchema } from './catalog'

describe('lab catalogue panels', () => {
  it('an ordinary test has no components', () => {
    const parsed = labCatalogEntrySchema.parse({ code: 'glu', name: 'Blood glucose', section: 'chemistry' })
    expect(parsed.components).toEqual([])
    expect(catalogInputToRow(parsed).components).toEqual([])
  })

  it('accepts a panel with LOINC-coded components', () => {
    const parsed = labCatalogPatchSchema.parse({ components: [{ loinc: '718-7', name: 'Haemoglobin', unit: 'g/dL' }, { loinc: '777-3', name: 'Platelets' }] })
    expect(catalogInputToRow(parsed)).toEqual({ components: [{ loinc: '718-7', name: 'Haemoglobin', unit: 'g/dL' }, { loinc: '777-3', name: 'Platelets' }] })
  })

  it('refuses a malformed LOINC, a duplicate analyte or unknown fields', () => {
    expect(labCatalogPatchSchema.safeParse({ components: [{ loinc: 'HB', name: 'Haemoglobin' }] }).success).toBe(false)
    expect(labCatalogPatchSchema.safeParse({ components: [{ loinc: '718-7', name: 'Hb' }, { loinc: '718-7', name: 'Hb again' }] }).success).toBe(false)
    expect(labCatalogPatchSchema.safeParse({ components: [{ loinc: '718-7', name: 'Hb', price: 5 }] }).success).toBe(false)
  })

  it('caps a panel at 40 tests', () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ loinc: `${1000 + i}-1`, name: `T${i}` }))
    expect(labCatalogPatchSchema.safeParse({ components: many }).success).toBe(false)
  })
})
