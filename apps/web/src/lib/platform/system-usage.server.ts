import { supabaseAdmin } from "@synapse/db/admin";

/** Supabase free plan limits that decide whether Synapse keeps running for free. */
export const FREE_TIER = {
  databaseBytes: 500 * 1024 * 1024,
  storageBytes: 1024 * 1024 * 1024,
  activeProjects: 2,
} as const;

export type UsageLevel = "ok" | "warn" | "over";

export function usageLevel(used: number, limit: number): UsageLevel {
  if (used >= limit) return "over";
  if (used >= limit * 0.8) return "warn";
  return "ok";
}

export type SystemUsage = {
  databaseBytes: number;
  storage: Array<{ bucket: string; objects: number; bytes: number }>;
  storageBytes: number;
  largestTables: Array<{ table: string; bytes: number; rows: number }>;
  connections: number;
  measuredAt: string;
};

/** null until migration 20261119150000_platform_control_centre is applied. */
export async function loadSystemUsage(): Promise<SystemUsage | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("platform_system_usage");
  if (error || !data) return null;
  const storage = ((data.storage ?? []) as Array<{ bucket: string; objects: number; bytes: number }>).map((s) => ({
    bucket: s.bucket,
    objects: Number(s.objects),
    bytes: Number(s.bytes),
  }));
  return {
    databaseBytes: Number(data.database_bytes),
    storage,
    storageBytes: storage.reduce((sum, s) => sum + s.bytes, 0),
    largestTables: ((data.largest_tables ?? []) as Array<{ table: string; bytes: number; rows: number }>).map((t) => ({
      table: t.table,
      bytes: Number(t.bytes),
      rows: Number(t.rows),
    })),
    connections: Number(data.connections ?? 0),
    measuredAt: String(data.measured_at ?? new Date().toISOString()),
  };
}

export type SlowQuery = { query: string; calls: number; meanMs: number; totalMs: number; rows: number };

export async function loadSlowQueries(limit = 10): Promise<SlowQuery[] | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("platform_slow_queries", { p_limit: limit });
  if (error || !Array.isArray(data)) return null;
  return (data as Array<Record<string, unknown>>).map((r) => ({
    query: String(r.query ?? ""),
    calls: Number(r.calls ?? 0),
    meanMs: Number(r.mean_ms ?? 0),
    totalMs: Number(r.total_ms ?? 0),
    rows: Number(r.rows ?? 0),
  }));
}

export type ActiveProjects = { configured: false } | { configured: true; active: number; names: string[]; error?: string };

/**
 * Active Supabase projects in the organisation (the free plan allows two).
 * Needs SUPABASE_ACCESS_TOKEN (a personal access token, free) on the server;
 * without it the card says so instead of guessing.
 */
export async function loadActiveProjects(): Promise<ActiveProjects> {
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token) return { configured: false };
  try {
    const res = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { configured: true, active: 0, names: [], error: `Supabase API answered ${res.status}` };
    const projects = (await res.json()) as Array<{ name: string; status: string }>;
    const active = projects.filter((p) => p.status !== "INACTIVE" && p.status !== "PAUSED" && !p.status.startsWith("REMOVED"));
    return { configured: true, active: active.length, names: active.map((p) => p.name) };
  } catch (err) {
    return { configured: true, active: 0, names: [], error: err instanceof Error ? err.message : "Supabase API unreachable" };
  }
}

export type RecentError = { at: string; source: string; message: string; href?: string };

/** Failures the system recorded in the last 7 days, newest first. */
export async function loadRecentErrors(): Promise<RecentError[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const settle = async <T,>(p: Promise<{ data: T[] | null }>): Promise<T[]> => {
    try {
      return (await p).data ?? [];
    } catch {
      return [];
    }
  };
  const [imports, invites, releaseMails, incidents] = await Promise.all([
    settle<Record<string, string | null>>(
      db.from("pharmacy_import_sessions").select("tenant_id, file_name, error_message, created_at").eq("status", "failed").gte("created_at", since).order("created_at", { ascending: false }).limit(10),
    ),
    settle<Record<string, string | null>>(
      db.from("facility_invitations").select("tenant_id, email, last_error, updated_at").not("last_error", "is", null).gte("updated_at", since).order("updated_at", { ascending: false }).limit(10),
    ),
    settle<Record<string, string | null>>(
      db.from("app_release_email_deliveries").select("email, error, claimed_at").eq("status", "failed").gte("claimed_at", since).order("claimed_at", { ascending: false }).limit(10),
    ),
    settle<Record<string, string | null>>(
      db.from("platform_incidents").select("service, severity, impact, status, started_at").neq("status", "resolved").order("started_at", { ascending: false }).limit(10),
    ),
  ]);
  const out: RecentError[] = [
    ...imports.map((r) => ({
      at: String(r.created_at),
      source: "Tally import",
      message: `${r.file_name ?? "Import"}: ${String(r.error_message ?? "failed").slice(0, 200)}`,
      href: r.tenant_id ? `/platform/tenants/${r.tenant_id}` : undefined,
    })),
    ...invites.map((r) => ({
      at: String(r.updated_at),
      source: "Invite email",
      message: `${r.email ?? ""}: ${String(r.last_error).slice(0, 200)}`,
      href: r.tenant_id ? `/platform/tenants/${r.tenant_id}` : undefined,
    })),
    ...releaseMails.map((r) => ({
      at: String(r.claimed_at),
      source: "APK release email",
      message: `${r.email ?? ""}: ${String(r.error ?? "failed").slice(0, 200)}`,
    })),
    ...incidents.map((r) => ({
      at: String(r.started_at),
      source: `Incident (${r.severity ?? "?"})`,
      message: `${r.service ?? "service"}: ${String(r.impact ?? r.status ?? "").slice(0, 200)}`,
      href: "/platform/incidents",
    })),
  ];
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
}

export type ApkRelease = {
  version: string;
  versionCode: number;
  apkUrl: string;
  notes: string | null;
  minimumVersion: string | null;
  source: string;
  gitCommit: string | null;
  publishedAt: string;
};

/** Latest APK releases from app_releases (#39), newest first; null if the table is missing. */
export async function loadApkReleases(limit = 5): Promise<{ releases: ApkRelease[]; emailed: number; failed: number } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("app_releases")
    .select("id, version, version_code, apk_url, notes, minimum_version, source, git_commit, published_at")
    .eq("platform", "android")
    .order("version_code", { ascending: false })
    .limit(limit);
  if (error) return null;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  let emailed = 0;
  let failed = 0;
  if (rows[0]?.id) {
    const [{ count: sent }, { count: bad }] = await Promise.all([
      db.from("app_release_email_deliveries").select("id", { count: "exact", head: true }).eq("release_id", rows[0].id).eq("status", "sent"),
      db.from("app_release_email_deliveries").select("id", { count: "exact", head: true }).eq("release_id", rows[0].id).eq("status", "failed"),
    ]);
    emailed = sent ?? 0;
    failed = bad ?? 0;
  }
  return {
    releases: rows.map((r) => ({
      version: String(r.version),
      versionCode: Number(r.version_code),
      apkUrl: String(r.apk_url),
      notes: (r.notes as string) ?? null,
      minimumVersion: (r.minimum_version as string) ?? null,
      source: String(r.source),
      gitCommit: (r.git_commit as string) ?? null,
      publishedAt: String(r.published_at),
    })),
    emailed,
    failed,
  };
}
