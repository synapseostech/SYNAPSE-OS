import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The copilot reads policies, benefits, encounters and diagnoses with the
 * service role, which bypasses RLS. Every read must therefore carry an explicit
 * tenant predicate; these tests pin that behaviour.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  calls: [] as { table: string; op: string; filters: [string, unknown][] }[],
}));

vi.mock("@synapse/db/admin", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => new FakeQuery(table) };
  },
}));

class FakeQuery {
  private filters: [string, unknown][] = [];
  private op: "select" | "insert" = "select";
  private payload: unknown = null;

  constructor(private readonly table: string) {}

  select() {
    return this;
  }

  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.run()).then((rows) => ({
      data: Array.isArray(rows) ? (rows[0] ?? null) : null,
      error: null,
    }));
  }

  then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
    const rows = this.run();
    const result = { data: this.op === "insert" ? null : rows, error: null };
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }

  catch(onRejected?: (reason: unknown) => unknown) {
    const rows = this.run();
    const result = { data: this.op === "insert" ? null : rows, error: null };
    return Promise.resolve(result).catch(onRejected);
  }

  private run(): Row[] {
    h.calls.push({ table: this.table, op: this.op, filters: this.filters });
    if (this.op === "insert") return [];
    const rows = h.rows[this.table] ?? [];
    return rows.filter((row) => this.filters.every(([column, value]) => row[column] === value));
  }
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const POLICY = "33333333-3333-4333-8333-333333333333";
const ENCOUNTER = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  h.rows = {};
  h.calls = [];
  vi.resetModules();
});

function selectsFor(table: string) {
  return h.calls.filter((call) => call.table === table && call.op === "select");
}

describe("runCoverageCheck", () => {
  it("refuses to read benefits when the policy belongs to another tenant", async () => {
    h.rows.insurance_policies = [{ id: POLICY, tenant_id: OTHER_TENANT, copay_amount: 0 }];
    h.rows.insurance_benefits = [{ policy_id: POLICY, benefit_key: "outpatient", limit_amount: 100 }];

    const { runCoverageCheck } = await import("./copilot");
    const result = await runCoverageCheck({
      tenantId: TENANT,
      patientId: PATIENT,
      policyId: POLICY,
      benefitKey: "outpatient",
      checkedBy: "user-1",
    });

    expect(result.covered).toBe(false);
    expect(result.notes).toMatch(/not found for this facility/i);
    expect(selectsFor("insurance_benefits")).toHaveLength(0);
  });

  it("reads benefits only after proving the policy, and reports coverage", async () => {
    h.rows.insurance_policies = [{ id: POLICY, tenant_id: TENANT, copay_amount: 10 }];
    h.rows.insurance_benefits = [
      { policy_id: POLICY, benefit_key: "outpatient", limit_amount: 100, used_amount: 20 },
    ];

    const { runCoverageCheck } = await import("./copilot");
    const result = await runCoverageCheck({
      tenantId: TENANT,
      patientId: PATIENT,
      policyId: POLICY,
      benefitKey: "outpatient",
      checkedBy: "user-1",
    });

    expect(result.covered).toBe(true);
    expect(result.copayAmount).toBe(10);
    expect(result.benefitLimit).toBe(100);
    const policyQuery = selectsFor("insurance_policies")[0];
    expect(policyQuery.filters).toContainEqual(["tenant_id", TENANT]);
  });
});

describe("generateClaimDraft", () => {
  it("does not read or trust an encounter outside the tenant", async () => {
    h.rows.encounters = [{ id: ENCOUNTER, tenant_id: OTHER_TENANT, patient_id: PATIENT }];
    h.rows.encounter_diagnoses = [{ encounter_id: ENCOUNTER, title: "Malaria", stem_code: "1F40" }];

    const { generateClaimDraft } = await import("./copilot");
    const draft = await generateClaimDraft({
      tenantId: TENANT,
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      policyId: POLICY,
      actorId: "user-1",
    });

    expect(draft.notes).toMatch(/could not be verified/i);
    expect(draft.notes).not.toContain("Malaria");
    expect(selectsFor("encounter_diagnoses")).toHaveLength(0);
  });

  it("builds the draft from an owned encounter", async () => {
    h.rows.encounters = [{ id: ENCOUNTER, tenant_id: TENANT, patient_id: PATIENT }];
    h.rows.encounter_diagnoses = [{ encounter_id: ENCOUNTER, title: "Malaria", stem_code: "1F40" }];

    const { generateClaimDraft } = await import("./copilot");
    const draft = await generateClaimDraft({
      tenantId: TENANT,
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      policyId: POLICY,
      actorId: "user-1",
    });

    expect(draft.id).toBe(ENCOUNTER);
    expect(draft.notes).toContain("Malaria");
    const query = selectsFor("encounters")[0];
    expect(query.filters).toContainEqual(["tenant_id", TENANT]);
    expect(query.filters).toContainEqual(["patient_id", PATIENT]);
  });
});
