import { beforeEach, describe, expect, it, vi } from "vitest"

const ME = "11111111-1111-4111-8111-111111111111"
const STAFF = "22222222-2222-4222-8222-222222222222"
const OUTSIDER = "33333333-3333-4333-8333-333333333333"
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const s = vi.hoisted(() => ({
  role: "pharmacy_staff",
  tables: {} as Record<string, any[]>,
  objects: new Set<string>(),
  signedUploads: [] as string[],
  removed: [] as string[],
}))

vi.mock("@synapse/auth", () => ({
  verifyToken: async () => ({ sub: "11111111-1111-4111-8111-111111111111", tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  validateSession: async () => ({ valid: true }),
  isAccountActivated: () => true,
  withMembershipSuspension: async (p: any) => p,
  resolveSessionScope: async () => ({ role: s.role, tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
}))
vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  isMobilePharmacyAdmin: (a: { role: string }) => a.role === "pharmacy_admin",
}))
vi.mock("@synapse/db/admin", () => {
  const from = (table: string) => {
    const rows = (s.tables[table] ??= [])
    const filters: Array<(r: any) => boolean> = []
    let patch: any = null
    const run = () => {
      const m = rows.filter((r) => filters.every((f) => f(r)))
      if (patch) m.forEach((r) => Object.assign(r, patch))
      return m
    }
    const q: any = {
      select: () => q,
      insert: (v: any) => (rows.push(v), q),
      update: (v: any) => ((patch = v), q),
      eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), q),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: run(), error: null }).then(res),
    }
    return q
  }
  const bucket = {
    createSignedUploadUrl: async (path: string) => {
      s.signedUploads.push(path)
      return { data: { signedUrl: `https://storage.test/upload/${path}` }, error: null }
    },
    createSignedUrls: async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://storage.test/read/${p}`, error: null })),
      error: null,
    }),
    list: async (folder: string) => ({
      data: [...s.objects].filter((o) => o.startsWith(`${folder}/`)).map((o) => ({ name: o.slice(folder.length + 1) })),
      error: null,
    }),
    remove: async (paths: string[]) => {
      paths.forEach((p) => {
        s.removed.push(p)
        s.objects.delete(p)
      })
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin: { from, storage: { from: () => bucket } } }
})

import { DELETE, POST, PUT } from "./route"

const call = (method: string, body?: unknown, query = "") =>
  ({
    method,
    headers: new Headers({ authorization: "Bearer t" }),
    json: async () => body ?? {},
    nextUrl: new URL(`http://x/api/mobile/profile/avatar${query}`),
  }) as any

beforeEach(() => {
  s.role = "pharmacy_staff"
  s.objects = new Set()
  s.signedUploads = []
  s.removed = []
  s.tables = {
    profiles: [
      { id: ME, role: "pharmacy_staff", tenant_id: TENANT, avatar_path: null },
      { id: STAFF, role: "pharmacy_cashier", tenant_id: TENANT, avatar_path: null },
      { id: OUTSIDER, role: "pharmacy_cashier", tenant_id: OTHER_TENANT, avatar_path: null },
    ],
    pharmacy_user_settings: [
      { tenant_id: TENANT, profile_id: ME },
      { tenant_id: TENANT, profile_id: STAFF },
      { tenant_id: OTHER_TENANT, profile_id: OUTSIDER },
    ],
    pharmacy_audit_logs: [],
  }
})

describe("POST /api/mobile/profile/avatar", () => {
  it("signs an upload inside the caller's own tenant/user folder", async () => {
    const res = await POST(call("POST", { contentType: "image/jpeg" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toMatch(new RegExp(`^${TENANT}/${ME}/\\d+\\.jpg$`))
    expect(s.signedUploads).toEqual([body.path])
  })

  it("refuses types other than JPEG, PNG and WebP", async () => {
    const res = await POST(call("POST", { contentType: "image/svg+xml" }))
    expect(res.status).toBe(400)
  })

  it("does not let staff upload for someone else", async () => {
    const res = await POST(call("POST", { contentType: "image/jpeg", userId: STAFF }))
    expect(res.status).toBe(403)
    expect(s.signedUploads).toEqual([])
  })

  it("lets a pharmacy admin set a photo for their own staff, not another pharmacy's", async () => {
    s.role = "pharmacy_admin"
    const ok = await POST(call("POST", { contentType: "image/png", userId: STAFF }))
    expect(ok.status).toBe(200)
    expect((await ok.json()).path).toMatch(new RegExp(`^${TENANT}/${STAFF}/\\d+\\.png$`))
    const other = await POST(call("POST", { contentType: "image/png", userId: OUTSIDER }))
    expect(other.status).toBe(404)
  })
})

describe("PUT /api/mobile/profile/avatar", () => {
  it("attaches an uploaded picture, removes the old one and returns a signed URL", async () => {
    const old = `${TENANT}/${ME}/1700000000000.jpg`
    const fresh = `${TENANT}/${ME}/1800000000000.jpg`
    s.objects.add(old)
    s.objects.add(fresh)
    s.tables.profiles[0].avatar_path = old
    const res = await PUT(call("PUT", { path: fresh }))
    expect(res.status).toBe(200)
    expect((await res.json()).avatarUrl).toBe(`https://storage.test/read/${fresh}`)
    expect(s.tables.profiles[0].avatar_path).toBe(fresh)
    expect(s.removed).toEqual([old])
  })

  it("refuses a path from another user's folder", async () => {
    const theirs = `${TENANT}/${STAFF}/1800000000000.jpg`
    s.objects.add(theirs)
    const res = await PUT(call("PUT", { path: theirs }))
    expect(res.status).toBe(400)
    expect(s.tables.profiles[0].avatar_path).toBeNull()
  })

  it("refuses traversal and odd names", async () => {
    for (const path of [`${TENANT}/${ME}/../x.jpg`, `${TENANT}/${ME}/a.jpg`, `${TENANT}/${ME}/1800000000000.svg`]) {
      const res = await PUT(call("PUT", { path }))
      expect(res.status).toBe(400)
    }
  })

  it("answers 409 when the upload never arrived", async () => {
    const res = await PUT(call("PUT", { path: `${TENANT}/${ME}/1800000000000.jpg` }))
    expect(res.status).toBe(409)
  })
})

describe("DELETE /api/mobile/profile/avatar", () => {
  it("clears the picture and removes the objects", async () => {
    const p = `${TENANT}/${ME}/1800000000000.jpg`
    s.objects.add(p)
    s.tables.profiles[0].avatar_path = p
    const res = await DELETE(call("DELETE"))
    expect(res.status).toBe(200)
    expect(s.tables.profiles[0].avatar_path).toBeNull()
    expect(s.removed).toEqual([p])
  })
})
