import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The notify endpoint previously accepted an arbitrary `userId` in the body and
 * resolved a patient to `patients.created_by` — the registering clinician — so
 * any authenticated caller could push a notification to any account.
 */

const h = vi.hoisted(() => ({
  state: {
    token: null as null | { sub: string; tenant_id?: string },
    sessionValid: true,
    patients: [] as { id: string; tenant_id: string }[],
    notified: [] as { userId: string; testName?: string | null }[],
  },
}));

vi.mock("@synapse/auth", () => ({
  verifyToken: async () => h.state.token,
  validateSession: async () => ({ valid: h.state.sessionValid }),
}));

vi.mock("@synapse/auth/mobile-push", () => ({
  notifyPatientLabResult: (input: { userId: string; testName?: string | null }) => {
    h.state.notified.push(input);
  },
}));

vi.mock("@synapse/db/admin", () => ({
  get supabaseAdmin() {
    return {
      from: () => {
        const filters: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return q;
          },
          maybeSingle: async () => ({
            data:
              h.state.patients.find(
                (patient) => patient.id === filters.id && patient.tenant_id === filters.tenant_id,
              ) ?? null,
            error: null,
          }),
        };
        return q;
      },
    };
  },
}));

const TOKEN = "token-abc";
const USER = "55555555-5555-4555-8555-555555555555";
const OTHER_USER = "66666666-6666-4666-8666-666666666666";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";

function request(body: unknown, token: string | null = TOKEN) {
  return new NextRequest("https://app.test/api/lab/notify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.state.token = { sub: USER, tenant_id: TENANT };
  h.state.sessionValid = true;
  h.state.patients = [{ id: PATIENT, tenant_id: TENANT }];
  h.state.notified = [];
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /api/lab/notify", () => {
  it("requires a bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ testName: "CBC" }, null));
    expect(res.status).toBe(401);
  });

  it("refuses to notify another account", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ userId: OTHER_USER, testName: "CBC" }));
    expect(res.status).toBe(403);
    expect(h.state.notified).toHaveLength(0);
  });

  it("notifies the caller for their own patient record", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ patientId: PATIENT, testName: "CBC" }));
    expect(res.status).toBe(200);
    expect(h.state.notified).toEqual([{ userId: USER, testName: "CBC" }]);
  });

  it("returns 404 for a patient outside the caller's tenant", async () => {
    h.state.patients.push({ id: OTHER_PATIENT, tenant_id: OTHER_TENANT });
    const { POST } = await import("./route");
    const res = await POST(request({ patientId: OTHER_PATIENT, testName: "CBC" }));
    expect(res.status).toBe(404);
    expect(h.state.notified).toHaveLength(0);
  });

  it("returns 404 for a malformed patient id", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ patientId: "not-a-uuid" }));
    expect(res.status).toBe(404);
  });
});
