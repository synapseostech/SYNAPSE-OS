export const LAB_SECTIONS = [
  'haematology', 'chemistry', 'microbiology', 'serology', 'parasitology',
  'urinalysis', 'immunology', 'molecular', 'histology', 'general',
] as const
export type LabSection = (typeof LAB_SECTIONS)[number]

export const LAB_SECTION_LABEL: Record<LabSection, string> = {
  haematology: 'Haematology', chemistry: 'Chemistry', microbiology: 'Microbiology', serology: 'Serology',
  parasitology: 'Parasitology', urinalysis: 'Urinalysis', immunology: 'Immunology', molecular: 'Molecular',
  histology: 'Histology', general: 'General',
}
