import { requirePlatformPage } from "@/lib/platform/auth";

// The page is a client component, so its server-side capability gate lives here.
export default async function GatedLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformPage("/platform/test-center");
  return children;
}
