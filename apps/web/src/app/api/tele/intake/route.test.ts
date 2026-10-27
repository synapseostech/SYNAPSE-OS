import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Regression tests for the telemedicine intake route.
 *
 * The route previously trusted a body-supplied case id, wrote enum values the
 * schema rejects (status "in_progress"/"triaged", roles "patient"/"ai"),
 * linked `patient_id` to an auth user id and swallowed every write error.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const h = vi.hoisted(() => ({
  state: {
    db: null as unknown,
    cookieToken: null as string | null,
    sessionValid: true,
    rateLimited: false,
    aiText: "",
    aiCalls: 0,
    env: { GEMINI_API_KEY: "test-key" } as Record<string, string | undefined>,
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        h.state.aiCalls += 1;
        return { text: h.state.aiText };
      },
    };
  },
}));

vi.mock("@synapse/auth", () => ({
  verifyToken: async () => (h.state.cookieToken ? { sub: "user-1" } : null),
  validateSession: async () => ({ valid: h.state.sessionValid }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (h.state.cookieToken ? { value: h.state.cookieToken } : undefined),
  }),
}));

vi.mock("../../../../lib/supabase/server", () => ({
  createServiceClient: () => h.state.db,
}));

vi.mock("../../../../lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: !h.state.rateLimited, remaining: 1 }),
  rateLimiters: { ai: {} },
}));

class FakeDb {
  rows: Record<string, Row[]> = {};
  calls: { table: string; op: string; payload?: unknown; filters: Filter[] }[] = [];
  errors: Record<string, unknown> = {};
  private id = 0;

  from(table: string) {
    if (!this.rows[table]) this.rows[table] = [];
    return new FakeQuery(this, table);
  }

  nextId() {
    this.id += 1;
    return `case-${this.id}`;
  }
}

class FakeQuery {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: unknown = null;
  private returning = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select() {
    if (this.op !== "select") this.returning = true;
    return this;
  }

  insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  async single() {
    const result = this.finish(false);
    const rows = (Array.isArray(result.data) ? result.data : []) as Row[];
    return { data: rows[0] ?? null, error: result.error };
  }

  async maybeSingle() {
    return this.single();
  }

  then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
    return Promise.resolve(this.finish(false)).then(onFulfilled, onRejected);
  }

  private finish(_strict: boolean) {
    const table = this.db.rows[this.table] ?? (this.db.rows[this.table] = []);

    if (this.op === "select") {
      this.db.calls.push({ table: this.table, op: "select", filters: this.filters });
      const matched = table.filter((row) => this.filters.every((f) => f(row)));
      const error = this.db.errors[`${this.table}:select`] ?? null;
      if (error) return { data: null, error };
      return { data: matched, error: null };
    }

    if (this.op === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      this.db.calls.push({
        table: this.table,
        op: "insert",
        payload: this.payload,
        filters: [],
      });
      const error = this.db.errors[`${this.table}:insert`] ?? null;
      if (error) return { data: null, error };
      const inserted = rows.map((row) => ({ id: `${this.table}-${this.db.nextId()}`, ...row }));
      table.push(...inserted);
      return { data: this.returning ? inserted : null, error: null };
    }

    this.db.calls.push({ table: this.table, op: "update", payload: this.payload, filters: this.filters });
    const error = this.db.errors[`${this.table}:update`] ?? null;
    if (error) return { data: null, error };
    const matched = table.filter((row) => this.filters.every((f) => f(row)));
    for (const row of matched) Object.assign(row, this.payload as Row);
    return { data: this.returning ? matched : null, error: null };
  }
}

function request(body: unknown) {
  return new NextRequest("https://app.test/api/tele/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function conversation(lastUser: string) {
  return [
    { role: "bot", content: "What is your main symptom?" },
    { role: "user", content: lastUser },
  ];
}

function callsFor(db: FakeDb, table: string, op: string) {
  return db.calls.filter((call) => call.table === table && call.op === op);
}

beforeEach(() => {
  const db = new FakeDb();
  h.state.db = db;
  db.rows["profiles"] = [{ id: "user-1", tenant_id: "tenant-a" }];
  h.state.cookieToken = "session-token";
  h.state.sessionValid = true;
  h.state.rateLimited = false;
  h.state.aiCalls = 0;
  h.state.aiText = "Thank you. How long has this been going on?";
  h.state.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  vi.resetModules();
});

describe("POST /api/tele/intake", () => {
  it("stores schema-conforming values and keeps the four-level urgency in the summary", async () => {
    h.state.aiText =
      'Please seek care now.\nTRIAGE_RESULT:{"urgency":"emergency","recommendation":"Go to A&E","summary":"Chest pain","action":"emergency"}';
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Chest pain") }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.persisted).toBe(true);
    expect(body.triage.urgency).toBe("emergency");

    const db = h.state.db as FakeDb;
    const caseInsert = callsFor(db, "telemedicine_intake_cases", "insert")[0];
    expect(caseInsert.payload).toMatchObject({
      user_id: "user-1",
      tenant_id: "tenant-a",
      status: "open",
      urgency: "routine",
      symptoms: "Chest pain",
    });
    expect(caseInsert.payload).not.toHaveProperty("patient_id");
    expect(caseInsert.payload).not.toHaveProperty("created_by");

    const messageInsert = callsFor(db, "telemedicine_intake_messages", "insert")[0];
    expect(messageInsert.payload).toEqual([
      { case_id: "telemedicine_intake_cases-case-1", tenant_id: "tenant-a", role: "user", content: "Chest pain" },
      { case_id: "telemedicine_intake_cases-case-1", tenant_id: "tenant-a", role: "assistant", content: "Please seek care now." },
    ]);

    const caseUpdate = callsFor(db, "telemedicine_intake_cases", "update")[0];
    expect(caseUpdate.payload).toMatchObject({
      urgency: "urgent",
      triage_summary: expect.objectContaining({ urgency: "emergency" }),
    });
    expect(caseUpdate.payload).not.toHaveProperty("status");
  });

  it("does not append to a case owned by another user", async () => {
    h.state.aiText = "Next question";
    // No case row exists for this caller, so the ownership lookup returns null.
    const otherCaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Fever"), caseId: otherCaseId }));
    expect(res.status).toBe(200);

    const db = h.state.db as FakeDb;
    expect(db.rows.telemedicine_intake_messages ?? []).toHaveLength(2);
    for (const row of db.rows.telemedicine_intake_messages ?? []) {
      expect(row.case_id).not.toBe(otherCaseId);
    }
    expect(callsFor(db, "telemedicine_intake_cases", "insert")).toHaveLength(1);
  });

  it("reports a persistence failure instead of claiming success", async () => {
    const db = h.state.db as FakeDb;
    db.errors["telemedicine_intake_messages:insert"] = { code: "42501", message: "denied" };
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Headache") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBeTruthy();
    expect(body.persisted).toBe(false);
    expect(body.caseId).toBeNull();
  });

  it("serves an anonymous caller without writing anything", async () => {
    h.state.cookieToken = null;
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Cough") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persisted).toBe(false);
    const db = h.state.db as FakeDb;
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a malformed conversation", async () => {
    const { POST } = await import("./route");
    expect((await POST(request({ messages: [] }))).status).toBe(400);
    expect((await POST(request({ messages: [{ role: "system", content: "hi" }] }))).status).toBe(400);
    expect(
      (await POST(request({ messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) })))
        .status,
    ).toBe(400);
  });

  it("rate limits before calling the model", async () => {
    h.state.rateLimited = true;
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Fever") }));
    expect(res.status).toBe(429);
    expect(h.state.aiCalls).toBe(0);
  });

  it("returns 503 when the model key is not configured", async () => {
    delete process.env.GEMINI_API_KEY;
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Fever") }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("AI_UNAVAILABLE");
    expect(h.state.aiCalls).toBe(0);
  });

  it("persists with a null tenant when the caller's profile has none, and warns once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (h.state.db as FakeDb).rows["profiles"] = [{ id: "user-1", tenant_id: null }];
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Fever") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persisted).toBe(true);

    const db = h.state.db as FakeDb;
    const caseInsert = callsFor(db, "telemedicine_intake_cases", "insert")[0];
    expect(caseInsert.payload).toMatchObject({ tenant_id: null, user_id: "user-1" });

    const messageInsert = callsFor(db, "telemedicine_intake_messages", "insert")[0];
    for (const row of messageInsert.payload as Row[]) {
      expect(row.tenant_id).toBeNull();
    }

    expect(warnSpy).toHaveBeenCalledWith("[tele/intake] tenant unresolved for user", {
      userId: "user-1",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("ignores a tenant supplied in the request body", async () => {
    (h.state.db as FakeDb).rows["profiles"] = [{ id: "user-1", tenant_id: "tenant-a" }];
    const { POST } = await import("./route");
    const res = await POST(
      request({ messages: conversation("Cough"), tenantId: "tenant-b" }),
    );
    expect(res.status).toBe(200);

    const db = h.state.db as FakeDb;
    const caseInsert = callsFor(db, "telemedicine_intake_cases", "insert")[0];
    expect(caseInsert.payload).toMatchObject({ tenant_id: "tenant-a" });
  });

  it("appends messages under the owned case's tenant, not the caller's current tenant", async () => {
    const db = h.state.db as FakeDb;
    const caseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.rows["telemedicine_intake_cases"] = [
      { id: caseId, user_id: "user-1", is_deleted: false, tenant_id: "tenant-other" },
    ];
    // Caller's profile tenant differs from the owned case's tenant.
    db.rows["profiles"] = [{ id: "user-1", tenant_id: "tenant-a" }];
    const { POST } = await import("./route");
    const res = await POST(request({ messages: conversation("Fever"), caseId }));
    expect(res.status).toBe(200);

    const messageInsert = callsFor(db, "telemedicine_intake_messages", "insert")[0];
    for (const row of messageInsert.payload as Row[]) {
      expect(row.case_id).toBe(caseId);
      expect(row.tenant_id).toBe("tenant-other");
    }
  });
});
