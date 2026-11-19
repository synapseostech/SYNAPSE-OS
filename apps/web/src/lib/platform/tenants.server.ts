import { supabaseAdmin } from "@synapse/db/admin";

/** The products a tenant can be, as the console shows them. */
export const TENANT_PRODUCTS = ["pharmacy", "hospital", "lab", "clinic", "other"] as const;
export type TenantProduct = (typeof TENANT_PRODUCTS)[number];

export function tenantProduct(facilityType: string | null | undefined): TenantProduct {
  const t = String(facilityType ?? "").toLowerCase();
  if (t === "pharmacy") return "pharmacy";
  if (t === "hospital") return "hospital";
  if (t === "laboratory" || t === "lab") return "lab";
  if (t === "clinic" || t === "health_centre" || t === "health_center") return "clinic";
  return "other";
}

export type TenantOverviewRow = {
  tenantId: string;
  name: string;
  slug: string | null;
  product: TenantProduct;
  facilityType: string | null;
  plan: string | null;
  tier: string | null;
  status: string | null;
  lifecycleStatus: string | null;
  isActive: boolean;
  isSynthetic: boolean;
  environment: string | null;
  onboardingCompleted: boolean | null;
  onboardingStep: number | null;
  createdAt: string | null;
  userCount: number;
  lastActivityAt: string | null;
  /** null when it could not be measured (control-centre migration not applied). */
  storageBytes: number | null;
  storageObjects: number | null;
  importCount: number;
  lastImportStatus: string | null;
  lastImportAt: string | null;
  lastImportFile: string | null;
  lastImportError: string | null;
};

type RpcRow = {
  tenant_id: string;
  name: string;
  slug: string | null;
  facility_type: string | null;
  plan: string | null;
  tier: string | null;
  status: string | null;
  lifecycle_status: string | null;
  is_active: boolean | null;
  is_synthetic: boolean | null;
  environment: string | null;
  onboarding_completed: boolean | null;
  onboarding_step: number | null;
  created_at: string | null;
  user_count: number | string | null;
  last_activity_at: string | null;
  storage_bytes: number | string | null;
  storage_objects: number | string | null;
  import_count: number | string | null;
  last_import_status: string | null;
  last_import_at: string | null;
  last_import_file: string | null;
  last_import_error: string | null;
};

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));

export function mapOverviewRow(r: RpcRow, storageMeasured = true): TenantOverviewRow {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    product: tenantProduct(r.facility_type),
    facilityType: r.facility_type,
    plan: r.plan,
    tier: r.tier,
    status: r.status,
    lifecycleStatus: r.lifecycle_status,
    isActive: r.is_active !== false,
    isSynthetic: r.is_synthetic === true,
    environment: r.environment,
    onboardingCompleted: r.onboarding_completed,
    onboardingStep: r.onboarding_step,
    createdAt: r.created_at,
    userCount: num(r.user_count),
    lastActivityAt: r.last_activity_at,
    storageBytes: storageMeasured ? num(r.storage_bytes) : null,
    storageObjects: storageMeasured ? num(r.storage_objects) : null,
    importCount: num(r.import_count),
    lastImportStatus: r.last_import_status,
    lastImportAt: r.last_import_at,
    lastImportFile: r.last_import_file,
    lastImportError: r.last_import_error,
  };
}

/**
 * Every tenant with its usage. Uses platform_tenant_overview() (migration
 * 20261119150000); until that is applied it falls back to plain queries and
 * reports storage as unmeasured rather than failing the page.
 */
export async function loadTenantOverview(): Promise<{ rows: TenantOverviewRow[]; source: "rpc" | "fallback" }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("platform_tenant_overview");
  if (!error && Array.isArray(data)) {
    return { rows: (data as RpcRow[]).map((r) => mapOverviewRow(r)), source: "rpc" };
  }

  const [{ data: tenants }, { data: profiles }, { data: imports }] = await Promise.all([
    db
      .from("tenants")
      .select("id, name, slug, facility_type, plan, tier, status, lifecycle_status, is_active, is_synthetic, environment, onboarding_completed, onboarding_step, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
    db.from("profiles").select("tenant_id, last_sign_in_at").not("tenant_id", "is", null).limit(10000),
    db
      .from("pharmacy_import_sessions")
      .select("tenant_id, status, created_at, file_name, error_message")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  const users = new Map<string, { n: number; last: string | null }>();
  for (const p of (profiles ?? []) as Array<{ tenant_id: string; last_sign_in_at: string | null }>) {
    const u = users.get(p.tenant_id) ?? { n: 0, last: null };
    u.n += 1;
    if (p.last_sign_in_at && (!u.last || p.last_sign_in_at > u.last)) u.last = p.last_sign_in_at;
    users.set(p.tenant_id, u);
  }
  const imp = new Map<string, { n: number; last: Record<string, string | null> | null }>();
  for (const i of (imports ?? []) as Array<Record<string, string | null>>) {
    const key = String(i.tenant_id);
    const entry = imp.get(key) ?? { n: 0, last: null };
    entry.n += 1;
    if (!entry.last) entry.last = i; // rows are newest first
    imp.set(key, entry);
  }

  const rows = ((tenants ?? []) as Array<Record<string, unknown>>).map((t) => {
    const id = String(t.id);
    const u = users.get(id);
    const i = imp.get(id);
    return mapOverviewRow(
      {
        tenant_id: id,
        name: String(t.name ?? t.slug ?? id),
        slug: (t.slug as string) ?? null,
        facility_type: (t.facility_type as string) ?? null,
        plan: (t.plan as string) ?? null,
        tier: (t.tier as string) ?? null,
        status: (t.status as string) ?? null,
        lifecycle_status: (t.lifecycle_status as string) ?? null,
        is_active: (t.is_active as boolean) ?? null,
        is_synthetic: (t.is_synthetic as boolean) ?? null,
        environment: (t.environment as string) ?? null,
        onboarding_completed: (t.onboarding_completed as boolean) ?? null,
        onboarding_step: (t.onboarding_step as number) ?? null,
        created_at: (t.created_at as string) ?? null,
        user_count: u?.n ?? 0,
        last_activity_at: u?.last ?? null,
        storage_bytes: null,
        storage_objects: null,
        import_count: i?.n ?? 0,
        last_import_status: i?.last?.status ?? null,
        last_import_at: i?.last?.created_at ?? null,
        last_import_file: i?.last?.file_name ?? null,
        last_import_error: i?.last?.error_message ?? null,
      },
      false,
    );
  });
  return { rows, source: "fallback" };
}

/** Individuals: people using My Health with no tenant (role patient). */
export async function loadIndividualsSummary(): Promise<{ count: number; activeLast30Days: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ count }, { count: active }] = await Promise.all([
    db.from("profiles").select("id", { count: "exact", head: true }).is("tenant_id", null).eq("role", "patient"),
    db
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .is("tenant_id", null)
      .eq("role", "patient")
      .gte("last_sign_in_at", since),
  ]);
  return { count: count ?? 0, activeLast30Days: active ?? 0 };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Plain-language state of a tenant's latest Tally import. */
export function importStateLabel(row: Pick<TenantOverviewRow, "lastImportStatus" | "importCount">): string {
  if (!row.importCount) return "No imports";
  const s = String(row.lastImportStatus ?? "").toLowerCase();
  if (s === "complete" || s === "completed") return "Imported";
  if (s === "failed" || s === "error") return "Failed";
  if (["pending", "processing", "mapping", "review", "importing"].includes(s)) return "In progress";
  if (s === "rolled_back" || s === "reverted") return "Rolled back";
  return s || "Unknown";
}
