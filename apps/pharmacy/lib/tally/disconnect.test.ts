/**
 * AC-9, the disconnect test, at the layer this repository can execute.
 *
 * `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` §7 requires that after cut-over the
 * bridge can be stopped and the client PC unreachable while the pharmacy signs
 * in, sells, buys, sees stock move, renders the migrated period and never waits
 * on Tally.
 *
 * What this file proves: the operating code has no runtime path into the Tally
 * import modules, and a sale completes through the real route handler with the
 * cut-over switch off and every outbound request poisoned.
 *
 * What it does not prove, and must never be quoted as proof of: a real browser
 * on the client's PC, a real Windows host, or a completed apply of real Tally
 * data. Those are AC-9 steps 1 and 5-6 on a deployed stack and stay NOT TESTED
 * until someone runs them there.
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  requirePharmacyPermission,
  gateFeature,
  findSaleIdempotency,
  storeSaleIdempotency,
  rpc,
  productMaybeSingle,
  settingsMaybeSingle,
  attachSaleToTill,
  recordTillSale,
  batchRows,
} = vi.hoisted(() => ({
  batchRows: { current: [] as Record<string, unknown>[] },
  attachSaleToTill: vi.fn(),
  recordTillSale: vi.fn(),
  requirePharmacyPermission: vi.fn(),
  gateFeature: vi.fn(),
  findSaleIdempotency: vi.fn(),
  storeSaleIdempotency: vi.fn(),
  rpc: vi.fn(),
  productMaybeSingle: vi.fn(),
  settingsMaybeSingle: vi.fn(),
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: (...args: unknown[]) => requirePharmacyPermission(...args),
}))

vi.mock("@synapse/auth/features", () => ({
  gateFeature: (...args: unknown[]) => gateFeature(...args),
}))

vi.mock("@/lib/pos/till-service", () => ({
  attachSaleToTill: (...args: unknown[]) => attachSaleToTill(...args),
  recordTillSale: (...args: unknown[]) => recordTillSale(...args),
}))

vi.mock("@/lib/pos/idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pos/idempotency")>()
  return {
    ...actual,
    findSaleIdempotency: (...args: unknown[]) => findSaleIdempotency(...args),
    storeSaleIdempotency: (...args: unknown[]) => storeSaleIdempotency(...args),
  }
})

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "pharmacy_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: settingsMaybeSingle }) }) }
      }
      if (table === "pharmacy_products") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: productMaybeSingle }),
              in: () => Promise.resolve({ data: [], error: null }),
              maybeSingle: productMaybeSingle,
            }),
          }),
        }
      }
      if (table === "pharmacy_product_batches") {
        const q: any = {
          select: () => q,
          eq: () => q,
          gt: () => q,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: batchRows.current, error: null }).then(resolve),
        }
        return q
      }
      return {
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }
    },
    rpc,
  },
}))

import { POST } from "@/app/api/admin/pos/complete-sale/route"
import { tallyCutoverEnabled } from "@/lib/tally/auth"

const PHARMACY_ROOT = path.resolve(__dirname, "../..")

/** Surfaces that are allowed to reach Tally at all after cut-over. */
const TALLY_SURFACES = [
  "lib/tally/",
  "app/api/admin/tally/",
  "app/portal/tally-import/",
  "components/tally/",
  ".next/",
]

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue
      sourceFiles(full, found)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

function relative(file: string): string {
  return path.relative(PHARMACY_ROOT, file).split(path.sep).join("/")
}

describe("AC-9: the pharmacy does not depend on Tally after cut-over", () => {
  describe("no operating module can reach the Tally importer", () => {
    it("imports nothing from lib/tally except the pure shared types", () => {
      const offenders: string[] = []

      for (const file of sourceFiles(PHARMACY_ROOT)) {
        const rel = relative(file)
        if (TALLY_SURFACES.some((prefix) => rel.startsWith(prefix))) continue

        const source = readFileSync(file, "utf8")
        for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']*tally[^"']*)["']/g)) {
          const specifier = match[1]
          // The only permitted cross-boundary import is the string predicate
          // in types.ts, which performs no I/O and reads only a note field.
          if (!/(^|\/)tally\/types$/.test(specifier)) {
            offenders.push(`${rel} -> ${specifier}`)
          }
        }
      }

      expect(offenders).toEqual([])
    })

    it("keeps every bridge and extraction module inside the Tally surfaces", () => {
      const io = sourceFiles(path.join(PHARMACY_ROOT, "lib/tally"))
        .map(relative)
        .filter((p) => /\/(bridge-command|extraction|live-extraction|apply|cutover|reconcile)\.ts$/.test(p))

      // If these move, the allowlist above stops matching and the guard above
      // would silently pass over the new location.
      expect(io.length).toBeGreaterThan(0)
      for (const file of io) {
        expect(TALLY_SURFACES.some((prefix) => file.startsWith(prefix))).toBe(true)
      }
    })
  })

  describe("a sale completes with the cut-over switched off and the network poisoned", () => {
    const poisoned = vi.fn((input: unknown) => {
      throw new Error(`outbound request during a sale: ${String(input)}`)
    })

    beforeEach(() => {
      process.env.NODE_ENV = "test"
      process.env.SYNAPSE_TALLY_CUTOVER_ENABLED = "false"
      process.env.SYNAPSE_JWT_SECRET =
        process.env.SYNAPSE_JWT_SECRET || "test-only-secret-not-real-000000000000"
      vi.stubGlobal("fetch", poisoned)
      poisoned.mockClear()

      requirePharmacyPermission.mockResolvedValue({
        ok: true as const,
        tenantId: "tenant-1",
        session: {
          userId: "cashier-1",
          email: "c@test.com",
          role: "pharmacy_cashier",
          pharmacyRole: "pharmacy_cashier",
          tenantId: "tenant-1",
          fullName: "Cashier",
          firstName: "Cash",
          lastName: "Ier",
          isAdmin: false,
          tenantName: "Care",
          tenantSlug: "care",
          tenantStatus: "active",
          modulesEnabled: [],
          mustChangePassword: false,
          permissions: [],
          isImpersonation: false,
          impersonatorId: null,
          storeId: null,
          profile: {
            tenant_id: "tenant-1",
            is_admin: false,
            full_name: "Cashier",
            first_name: "Cash",
            last_name: "Ier",
          },
          user: { id: "cashier-1", email: "c@test.com" },
        },
      })
      gateFeature.mockResolvedValue(null)
      settingsMaybeSingle.mockResolvedValue({
        data: { discount_approval_threshold_pct: 5, vat_enabled: true, vat_rate: 18 },
        error: null,
      })
      productMaybeSingle.mockResolvedValue({
        data: { id: "p1", price: 1000, name: "Paracetamol", is_active: true, vat_category: "standard" },
        error: null,
      })
      findSaleIdempotency.mockResolvedValue(null)
      storeSaleIdempotency.mockResolvedValue(undefined)
      attachSaleToTill.mockResolvedValue({ ok: true, sessionId: "till-1" })
      recordTillSale.mockResolvedValue(undefined)
      rpc.mockResolvedValue({ data: { sale_id: "s1", receipt_number: "R-1" }, error: null })
      batchRows.current = [
        {
          id: "batch-1",
          batch_number: "BATCH-1",
          quantity: 100,
          expiry_date: "2099-12-31",
          cost_price: 500,
          selling_price: 1000,
          manufacturer: null,
          is_active: true,
          status: "active",
        },
      ]
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      delete process.env.SYNAPSE_TALLY_CUTOVER_ENABLED
    })

    it("the cut-over switch is closed in this run", () => {
      expect(tallyCutoverEnabled({ SYNAPSE_TALLY_CUTOVER_ENABLED: "false" })).toBe(false)
      expect(tallyCutoverEnabled({ NODE_ENV: "production" })).toBe(false)
      expect(tallyCutoverEnabled({})).toBe(true)
    })

    it("rings up a sale without a single outbound request", async () => {
      const res = await POST(
        new Request("https://pharm.test/api/admin/pos/complete-sale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }],
            paymentMethod: "cash",
            amountPaid: 1180,
          }),
        }) as any,
      )

      expect(res.status).toBe(200)
      expect(rpc).toHaveBeenCalledWith(
        "complete_pharmacy_sale",
        expect.objectContaining({ p_tax_amount: 180 }),
      )
      expect(poisoned).not.toHaveBeenCalled()
    })
  })
})
