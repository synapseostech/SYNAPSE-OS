import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Regression tests for the patient import surface.
 *
 * These run against an in-memory stand-in for the Supabase client so the real
 * guard, the real routes and the real mapping code are exercised without a
 * database. The properties under test are the ones that previously failed:
 * authorization, cross-tenant isolation, duplicate execution, invalid rows and
 * honest partial reporting.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const h = vi.hoisted(() => ({
  state: { db: null as unknown, staffContext: null as unknown, capability: null as unknown },
}));

vi.mock("server-only", () => ({}));

vi.mock("@synapse/db/admin", () => ({
  get supabaseAdmin() {
    return h.state.db;
  },
}));

vi.mock("../supabase/server", () => ({
  get supabaseAdmin() {
    return h.state.db;
  },
  createServiceClient: () => h.state.db,
}));

vi.mock("../hospital-dept/context", () => ({
  requireHospitalStaffContext: async () => h.state.staffContext,
}));

vi.mock("../hospital-shared", () => ({
  isContextError: (value: unknown) => value instanceof NextResponse,
  requireHospitalCapability: async () => h.state.capability,
}));

vi.mock("../rate-limit", () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimiters: { import: {} },
}));

class FakeQuery {
  private filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitTo: number | null = null;
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: unknown = null;
  private returning = false;
  private wantCount = false;
  private headOnly = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      if (options?.count) this.wantCount = true;
      if (options?.head) this.headOnly = true;
    } else {
      this.returning = true;
    }
    return this;
  }

  insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push((row) => {
      const cell = row[column];
      return cell != null && String(cell) < String(value);
    });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending ?? true };
    return this;
  }

  limit(count: number) {
    this.limitTo = count;
    return this;
  }

  async single() {
    const result = this.run();
    const rows = (result.data as Row[] | null) ?? [];
    if (rows.length !== 1) {
      return { data: null, error: { code: "PGRST116", message: "no rows" } };
    }
    return { data: rows[0], error: null };
  }

  async maybeSingle() {
    const result = this.run();
    const rows = (result.data as Row[] | null) ?? [];
    return { data: rows[0] ?? null, error: null };
  }

  then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    const table = this.db.table(this.table);

    if (this.op === "insert") {
      const inserted: Row[] = [];
      for (const raw of this.payload as Row[]) {
        if (this.table === "patients") {
          // Mirrors idx_patients_mrn_hospital_unique.
          const clash = table.some(
            (existing) =>
              existing.hospital_id === raw.hospital_id && existing.mrn === raw.mrn,
          );
          if (clash) {
            return {
              data: null,
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "idx_patients_mrn_hospital_unique"',
              },
            };
          }
        }
        const row = { id: `${this.table}-${this.db.nextId()}`, ...raw };
        table.push(row);
        inserted.push(row);
      }
      return { data: inserted, error: null };
    }

    if (this.op === "update") {
      const matched = table.filter((row) => this.matches(row));
      for (const row of matched) Object.assign(row, this.payload as Row);
      return { data: this.returning ? matched : null, error: null };
    }

    if (this.op === "delete") {
      const keep = table.filter((row) => !this.matches(row));
      this.db.replace(this.table, keep);
      return { data: null, error: null };
    }

    let rows = table.filter((row) => this.matches(row));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const left = a[column] as number;
        const right = b[column] as number;
        return ascending ? left - right : right - left;
      });
    }
    if (this.limitTo != null) rows = rows.slice(0, this.limitTo);

    if (this.headOnly) return { data: null, error: null, count: rows.length };
    return { data: rows, error: null, count: this.wantCount ? rows.length : undefined };
  }
}

class FakeDb {
  private tables: Record<string, Row[]> = {};
  private id = 0;

  nextId() {
    this.id += 1;
    return String(this.id).padStart(4, "0");
  }

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  replace(name: string, rows: Row[]) {
    this.tables[name] = rows;
  }

  from(name: string) {
    return new FakeQuery(this, name);
  }
}

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "99999999-9999-4999-8999-999999999999";
const HOSPITAL_A = "22222222-2222-4222-8222-222222222222";
const USER = "55555555-5555-4555-8555-555555555555";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";

const staffContext = {
  userId: USER,
  email: "clinician@example.test",
  role: "doctor",
  tenantId: TENANT_A,
  hospitalId: HOSPITAL_A,
  facilityType: "hospital",
  fullName: "Test Clinician",
};

let db: FakeDb;

function seedBatch(overrides: Partial<Row> = {}) {
  const batch = {
    id: BATCH_ID,
    tenant_id: TENANT_A,
    hospital_id: HOSPITAL_A,
    status: "uploaded",
    total_rows: 0,
    valid_rows: 0,
    error_rows: 0,
    summary: null,
    ...overrides,
  };
  db.table("import_batches").push(batch);
  return batch;
}

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = new FakeDb();
  h.state.db = db;
  h.state.staffContext = staffContext;
  h.state.capability = null;
  process.env.SYNAPSE_ALLOW_PATIENT_IMPORT = "true";
});

afterEach(() => {
  delete process.env.SYNAPSE_ALLOW_PATIENT_IMPORT;
  vi.resetModules();
});

describe("import kill switch", () => {
  it("refuses every endpoint when the flag is not set", async () => {
    delete process.env.SYNAPSE_ALLOW_PATIENT_IMPORT;
    const { POST } = await import("../../app/api/import/start/route");
    const res = await POST(
      jsonRequest("https://app.test/api/import/start", {
        sourceType: "csv",
        sourceName: "patients.csv",
        importScope: "patients",
      }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("IMPORT_DISABLED");
    expect(db.table("import_batches")).toHaveLength(0);
  });

  it("treats a falsy flag value as disabled", async () => {
    process.env.SYNAPSE_ALLOW_PATIENT_IMPORT = "false";
    const { POST } = await import("../../app/api/import/start/route");
    const res = await POST(
      jsonRequest("https://app.test/api/import/start", {
        sourceType: "csv",
        sourceName: "patients.csv",
        importScope: "patients",
      }),
    );
    expect(res.status).toBe(503);
  });
});

describe("POST /api/import/start", () => {
  it("rejects an unauthenticated caller", async () => {
    h.state.staffContext = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { POST } = await import("../../app/api/import/start/route");
    const res = await POST(
      jsonRequest("https://app.test/api/import/start", {
        sourceType: "csv",
        sourceName: "patients.csv",
        importScope: "patients",
      }),
    );
    expect(res.status).toBe(401);
    expect(db.table("import_batches")).toHaveLength(0);
  });

  it("rejects a caller without the patient write capability", async () => {
    h.state.capability = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { POST } = await import("../../app/api/import/start/route");
    const res = await POST(
      jsonRequest("https://app.test/api/import/start", {
        sourceType: "csv",
        sourceName: "patients.csv",
        importScope: "patients",
      }),
    );
    expect(res.status).toBe(403);
    expect(db.table("import_batches")).toHaveLength(0);
  });

  it("derives tenant and facility from the session", async () => {
    const { POST } = await import("../../app/api/import/start/route");
    const res = await POST(
      jsonRequest("https://app.test/api/import/start", {
        sourceType: "csv",
        sourceName: "patients.csv",
        importScope: "patients",
      }),
    );
    expect(res.status).toBe(200);
    const batch = db.table("import_batches")[0];
    expect(batch.tenant_id).toBe(TENANT_A);
    expect(batch.hospital_id).toBe(HOSPITAL_A);
    expect(batch.created_by).toBe(USER);
  });

  it("refuses a body that claims another facility", async () => {
    const { POST } = await import("../../app/api/import/start/route");
    const res = await POST(
      jsonRequest("https://app.test/api/import/start", {
        hospitalId: TENANT_B,
        sourceType: "csv",
        sourceName: "patients.csv",
        importScope: "patients",
      }),
    );
    expect(res.status).toBe(403);
    expect(db.table("import_batches")).toHaveLength(0);
  });
});

describe("POST /api/import/upload", () => {
  function uploadRequest(batchId: string, content: string, name = "patients.csv") {
    const form = new FormData();
    form.append("batchId", batchId);
    form.append("file", new File([content], name, { type: "text/csv" }));
    return new NextRequest("https://app.test/api/import/upload", { method: "POST", body: form });
  }

  it("stages valid rows and reports malformed ones", async () => {
    seedBatch();
    const { POST } = await import("../../app/api/import/upload/route");
    const res = await POST(
      uploadRequest(
        BATCH_ID,
        'full_name,mrn,village\n"Kato, Jr.",MRN-1,Kampala\nShort Row\n',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stagedRows).toBe(1);
    expect(body.malformedRows).toBe(1);
    expect(body.totalRows).toBe(2);

    const rows = db.table("import_batch_rows");
    expect(rows).toHaveLength(2);
    const staged = rows.find((r) => r.status === "pending");
    expect(staged?.source_record).toMatchObject({ full_name: "Kato, Jr." });
  });

  it("does not stage rows for another tenant's batch", async () => {
    seedBatch({ tenant_id: TENANT_B });
    const { POST } = await import("../../app/api/import/upload/route");
    const res = await POST(uploadRequest(BATCH_ID, "full_name,mrn\nAmina,MRN-1\n"));
    expect(res.status).toBe(404);
    expect(db.table("import_batch_rows")).toHaveLength(0);
  });

  it("rejects an unsupported file type", async () => {
    seedBatch();
    const { POST } = await import("../../app/api/import/upload/route");
    const res = await POST(uploadRequest(BATCH_ID, "x", "patients.xlsx"));
    expect(res.status).toBe(415);
  });

  it("counts the whole batch when a corrected file is re-uploaded", async () => {
    seedBatch();
    db.table("import_batch_rows").push({
      id: "row-imported",
      batch_id: BATCH_ID,
      tenant_id: TENANT_A,
      row_number: 2,
      status: "imported",
      source_record: { full_name: "Already In", mrn: "MRN-0" },
    });
    const { POST } = await import("../../app/api/import/upload/route");
    const res = await POST(uploadRequest(BATCH_ID, "full_name,mrn\nAmina,MRN-1\nBosco,MRN-2\n"));
    expect(res.status).toBe(200);
    expect((await res.json()).stagedRows).toBe(2);

    const batch = db.table("import_batches")[0];
    expect(batch.total_rows).toBe(3);
    expect(batch.valid_rows).toBe(1);
    expect(batch.error_rows).toBe(0);
  });

  it("rejects a malformed batch id without querying", async () => {
    const { POST } = await import("../../app/api/import/upload/route");
    const res = await POST(uploadRequest("not-a-uuid", "full_name,mrn\nAmina,MRN-1\n"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/import/execute", () => {
  function seedRow(record: Record<string, string>, rowNumber: number) {
    db.table("import_batch_rows").push({
      id: `row-${rowNumber}`,
      batch_id: BATCH_ID,
      tenant_id: TENANT_A,
      row_number: rowNumber,
      status: "pending",
      source_record: record,
      dedupe_key: `k${rowNumber}`,
    });
  }

  it("imports valid rows, reports invalid ones and finishes honestly", async () => {
    seedBatch();
    seedRow({ full_name: "Amina", mrn: "MRN-1", dob: "1990-01-15" }, 2);
    seedRow({ full_name: "No Mrn" }, 3);
    const { POST } = await import("../../app/api/import/execute/route");
    const res = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 1, errored: 1, remaining: 0, status: "completed" });

    const patients = db.table("patients");
    expect(patients).toHaveLength(1);
    expect(patients[0]).toMatchObject({
      full_name: "Amina",
      mrn: "MRN-1",
      dob: "1990-01-15",
      tenant_id: TENANT_A,
      hospital_id: HOSPITAL_A,
    });

    const batch = db.table("import_batches")[0];
    expect(batch.status).toBe("completed");
    expect(batch.valid_rows).toBe(1);
    expect(batch.error_rows).toBe(1);
  });

  it("never takes tenant or facility from the uploaded record", async () => {
    seedBatch();
    seedRow(
      { full_name: "Amina", mrn: "MRN-1", tenant_id: TENANT_B, hospital_id: TENANT_B },
      2,
    );
    const { POST } = await import("../../app/api/import/execute/route");
    await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(db.table("patients")[0]).toMatchObject({ tenant_id: TENANT_A, hospital_id: HOSPITAL_A });
  });

  it("reports an existing MRN as an error and does not merge records", async () => {
    db.table("patients").push({
      id: "existing",
      hospital_id: HOSPITAL_A,
      tenant_id: TENANT_A,
      mrn: "MRN-1",
      full_name: "Someone Else",
    });
    seedBatch();
    seedRow({ full_name: "Amina", mrn: "MRN-1" }, 2);
    const { POST } = await import("../../app/api/import/execute/route");
    const res = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(await res.json()).toMatchObject({ imported: 0, errored: 1 });
    expect(db.table("patients")).toHaveLength(1);
    expect(db.table("patients")[0].full_name).toBe("Someone Else");
  });

  it("refuses to execute another tenant's batch", async () => {
    seedBatch({ tenant_id: TENANT_B });
    const { POST } = await import("../../app/api/import/execute/route");
    const res = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(res.status).toBe(404);
    expect(db.table("import_batches")[0].status).toBe("uploaded");
  });

  it("refuses a second execution of a completed batch", async () => {
    seedBatch({ status: "completed" });
    const { POST } = await import("../../app/api/import/execute/route");
    const res = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(res.status).toBe(409);
  });

  it("refuses a second execution while the first is importing", async () => {
    seedBatch({ status: "importing", started_at: new Date().toISOString() });
    const { POST } = await import("../../app/api/import/execute/route");
    const res = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(res.status).toBe(409);
  });

  it("reclaims a run that died before it could finalize", async () => {
    seedBatch({
      status: "importing",
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    seedRow({ full_name: "Amina", mrn: "MRN-1" }, 2);
    const { POST } = await import("../../app/api/import/execute/route");
    const res = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 1, status: "completed" });
    expect(db.table("import_batches")[0].status).toBe("completed");
  });

  it("can be retried after a partial run without duplicating imported patients", async () => {
    seedBatch();
    seedRow({ full_name: "Amina", mrn: "MRN-1" }, 2);
    const { POST } = await import("../../app/api/import/execute/route");

    const first = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(await first.json()).toMatchObject({ imported: 1 });

    // Simulate a fresh page of work arriving after the first run finished.
    seedRow({ full_name: "Bosco", mrn: "MRN-2" }, 3);
    db.table("import_batches")[0].status = "completed_with_errors";

    const second = await POST(jsonRequest("https://app.test/api/import/execute", { batchId: BATCH_ID }));
    expect(await second.json()).toMatchObject({ imported: 2, errored: 0, status: "completed" });
    expect(db.table("patients")).toHaveLength(2);
  });
});

describe("GET /api/import/status/[batchId]", () => {
  async function status(batchId: string) {
    const { GET } = await import("../../app/api/import/status/[batchId]/route");
    return GET(new NextRequest(`https://app.test/api/import/status/${batchId}`), {
      params: Promise.resolve({ batchId }),
    });
  }

  it("requires a session", async () => {
    h.state.staffContext = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    seedBatch();
    const res = await status(BATCH_ID);
    expect(res.status).toBe(401);
  });

  it("returns 404 for another tenant's batch", async () => {
    seedBatch({ tenant_id: TENANT_B });
    const res = await status(BATCH_ID);
    expect(res.status).toBe(404);
  });

  it("returns progress for the caller's own batch", async () => {
    seedBatch({ total_rows: 4, valid_rows: 3, error_rows: 1, status: "completed" });
    const res = await status(BATCH_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ progressPercent: 100, validRows: 3, errorRows: 1 });
  });

  it("returns 404 for a malformed id", async () => {
    const res = await status("not-a-uuid");
    expect(res.status).toBe(404);
  });
});
