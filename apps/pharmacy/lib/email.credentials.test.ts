import { describe, expect, it, vi } from "vitest"

vi.mock("resend", () => ({ Resend: class { emails = { send: vi.fn() } } }))

describe("pharmacy email module", () => {
  it("exposes no temp-password generator or password-bearing staff email", async () => {
    const mod = (await import("./email")) as Record<string, unknown>
    expect(mod.generateTempPassword).toBeUndefined()
    expect(mod.sendStaffWelcomeEmail).toBeUndefined()
  })

  it("staff welcome uses a setup link, not a password", async () => {
    const { generateWelcomeEmail } = await import("./email")
    const html = String(generateWelcomeEmail("Ada", "ada@example.test", "https://pharm.synapseos.tech/setup/tok", "pharmacist"))
    expect(html).toContain("https://pharm.synapseos.tech/setup/tok")
    expect(html).not.toMatch(/temporary password/i)
  })
})
