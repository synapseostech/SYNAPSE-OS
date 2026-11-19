export const dynamic = "force-dynamic"

import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"

export default async function MobileBuildsPage() {
  await requirePlatformPage("/platform/mobile")
  const connected = Boolean(process.env.EXPO_TOKEN)
  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Mobile builds"
        title="Expo / EAS monitor"
        description="The adapter is in place. Until EAS credentials exist, status is NOT CONNECTED — not a fake successful build."
      />
      <article className="rounded-2xl border border-subtle bg-surface p-5">
        <p className="text-sm text-primary-color">Expo project</p>
        <p className="mt-2 text-2xl font-semibold text-[#E8B84B]">{connected ? "Configured" : "NOT CONNECTED"}</p>
        <dl className="mt-4 grid gap-2 text-sm text-muted-color sm:grid-cols-2">
          <div>
            <dt>Android version</dt>
            <dd className="text-primary-color">See apps/app app.json when EAS is linked</dd>
          </div>
          <div>
            <dt>Update channel</dt>
            <dd className="text-primary-color">NOT CONNECTED</dd>
          </div>
          <div>
            <dt>Latest APK/AAB</dt>
            <dd className="text-primary-color">Public download remains /download/android</dd>
          </div>
          <div>
            <dt>Release notes</dt>
            <dd className="text-primary-color">NOT CONNECTED</dd>
          </div>
        </dl>
      </article>
    </div>
  )
}
