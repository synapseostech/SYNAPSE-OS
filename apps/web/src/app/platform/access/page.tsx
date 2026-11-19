export const dynamic = "force-dynamic";

import { supabaseAdmin } from "@synapse/db/admin";
import { requirePlatformPage } from "@/lib/platform/auth";
import { listPlatformMembers } from "@/lib/platform/membership.server";
import { PlatformAccessClient } from "./PlatformAccessClient";

export default async function PlatformAccessPage() {
  const actor = await requirePlatformPage("/platform/access");
  const members = await listPlatformMembers();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data: invitations } = await db
    .from("platform_invitations")
    .select("id, email, full_name, platform_role, status, sent_at, expires_at, resent_count")
    .eq("status", "PENDING")
    .order("sent_at", { ascending: false })
    .limit(50);

  return (
    <PlatformAccessClient
      members={members}
      invitations={invitations ?? []}
      actorRole={actor.platformRole}
    />
  );
}
