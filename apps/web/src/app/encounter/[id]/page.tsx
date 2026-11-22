'use client'

import { useParams } from 'next/navigation'
import { ConsultationWorkspace } from '@/components/consultation/ConsultationWorkspace'

/**
 * The consultation: patient history and trends on the left, today's history
 * and examination in the middle, likely diagnoses (ICD-11) and the tests that
 * confirm them on the right. Orders, disposition, timeline and signing stay on
 * their own pages, linked from the header.
 */
export default function EncounterPage() {
  const params = useParams<{ id: string }>()
  return <ConsultationWorkspace encounterId={params.id} />
}
