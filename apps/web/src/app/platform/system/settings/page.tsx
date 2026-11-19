import { requirePlatformPage } from "../../../../lib/platform/auth";

export default async function SystemSettingsPage() {
  await requirePlatformPage("/platform/system/settings");

  return (
    <main className="min-h-screen bg-base text-primary-color p-8">
      <h1 className="font-display text-2xl">System Settings</h1>
      <p className="text-muted-color mt-2">Coming soon.</p>
    </main>
  );
}
