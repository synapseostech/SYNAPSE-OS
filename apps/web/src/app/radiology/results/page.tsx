import { redirect } from 'next/navigation'

/** Reports awaiting a radiologist live on the worklist's "To verify" tab. */
export default function RadiologyResultsPage() {
  redirect('/radiology/orders?view=reported')
}
