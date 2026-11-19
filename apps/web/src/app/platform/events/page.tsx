import { Suspense } from "react"
import { requirePlatformPage } from "@/lib/platform/auth"
import EventExplorerPage from "./explorer"

export default async function EventsPage() {
  await requirePlatformPage("/platform/events")
  return (
    <Suspense fallback={<p className="text-sm text-muted-color">Loading event explorer…</p>}>
      <EventExplorerPage />
    </Suspense>
  )
}
