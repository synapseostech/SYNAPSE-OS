import { requirePlatformPage } from "../../../lib/platform/auth";

export default async function PlatformGuidelinesPage() {
  await requirePlatformPage("/platform/guidelines");

  return (
    <main className="min-h-screen bg-base text-primary-color p-8">
      <h1 className="font-display text-2xl">Clinical Guidelines</h1>
      <p className="text-muted-color mt-2">Coming soon.</p>
    </main>
  );
}
