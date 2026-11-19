import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "../../../../lib/supabase/server";
import { requirePlatformAdminApi } from "../../../../lib/platform/auth";

type Result = {
  title: string;
  subtitle: string;
  href: string;
  type: string;
};

/** Escape PostgREST filter special characters to reduce filter-injection risk. */
function sanitizeSearchTerm(raw: string) {
  return raw.replace(/[%(),.*\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
}

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdminApi("tenant.read");
  if (!auth.ok) return auth.response;

  const q = sanitizeSearchTerm(request.nextUrl.searchParams.get("q") ?? "");
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const supabaseAdmin = createServiceClient();
  const results: Result[] = [];
  const pattern = `%${q}%`;

  const [tenantsByName, tenantsBySlug, usersByName, usersByEmail, usersBySynapse, tickets, audit] = await Promise.allSettled([
    (supabaseAdmin as any).from("tenants").select("id, name, slug, facility_type, email").ilike("name", pattern).limit(5),
    (supabaseAdmin as any).from("tenants").select("id, name, slug, facility_type, email").ilike("slug", pattern).limit(5),
    (supabaseAdmin as any).from("profiles").select("id, full_name, email, role, synapse_id").ilike("full_name", pattern).limit(5),
    (supabaseAdmin as any).from("profiles").select("id, full_name, email, role, synapse_id").ilike("email", pattern).limit(5),
    (supabaseAdmin as any).from("profiles").select("id, full_name, email, role, synapse_id").ilike("synapse_id", pattern).limit(5),
    (supabaseAdmin as any).from("support_tickets").select("id, subject, status").ilike("subject", pattern).limit(5),
    (supabaseAdmin as any)
      .from("audit_log")
      .select("id, action, table_name, created_at")
      .ilike("action", pattern)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const tenantRows = new Map<string, Record<string, unknown>>();
  for (const settled of [tenantsByName, tenantsBySlug]) {
    if (settled.status === "fulfilled" && settled.value.data) {
      for (const row of settled.value.data) tenantRows.set(row.id, row);
    }
  }
  for (const row of tenantRows.values()) {
    results.push({
      title: (row.name as string) ?? "Facility",
      subtitle: `${(row.facility_type as string) ?? "facility"} · ${(row.slug as string) ?? row.id}`,
      href: `/platform/facilities/${row.id}`,
      type: "facility",
    });
  }

  const userRows = new Map<string, Record<string, unknown>>();
  for (const settled of [usersByName, usersByEmail, usersBySynapse]) {
    if (settled.status === "fulfilled" && settled.value.data) {
      for (const row of settled.value.data) userRows.set(row.id, row);
    }
  }
  for (const row of userRows.values()) {
    results.push({
      title: (row.full_name as string) ?? (row.email as string) ?? "User",
      subtitle: `${(row.role as string) ?? "user"} · ${(row.email as string) ?? ""}`,
      href: `/platform/users/${row.id}`,
      type: "user",
    });
  }

  if (tickets.status === "fulfilled" && tickets.value.data) {
    for (const row of tickets.value.data) {
      results.push({
        title: row.subject ?? "Ticket",
        subtitle: row.status ?? "open",
        href: "/platform/support",
        type: "ticket",
      });
    }
  }

  if (audit.status === "fulfilled" && audit.value.data) {
    for (const row of audit.value.data) {
      results.push({
        title: row.action ?? "Audit event",
        subtitle: row.table_name ?? "audit_log",
        href: "/platform/audit-log",
        type: "audit",
      });
    }
  }

  return NextResponse.json({ results });
}
