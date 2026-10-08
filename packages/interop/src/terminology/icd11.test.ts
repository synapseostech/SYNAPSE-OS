import { describe, expect, it } from "vitest"
import { icd11TitleToPlainText, lookupStem, searchIcd11, searchWhoIcd11, whoApiConfigured } from "./icd11"

describe("ICD-11 terminology survival", () => {
  it("searches and looks up the seed cache without WHO", () => {
    const hits = searchIcd11("malaria")
    expect(hits[0]?.stemCode).toBeTruthy()
    expect(lookupStem(hits[0]!.stemCode)?.title).toMatch(/Malaria/i)
  })

  it("falls back to cache when credentials are missing", async () => {
    const result = await searchWhoIcd11("pneumonia", { env: {} })
    expect(result.source).toBe("cache")
    expect(result.degraded).toBe(true)
    expect(result.hits.length).toBeGreaterThan(0)
    expect(whoApiConfigured({})).toBe(false)
  })

  it("falls back to cache when the WHO provider fails", async () => {
    const result = await searchWhoIcd11("sepsis", {
      env: { WHO_ICD11_CLIENT_ID: "id", WHO_ICD11_CLIENT_SECRET: "secret" },
      fetchImpl: async () => new Response("nope", { status: 503 }),
    })
    expect(result.source).toBe("cache")
    expect(result.degraded).toBe(true)
    expect(result.hits.some((hit) => hit.stemCode === "1G40")).toBe(true)
  })
})

describe("ICD-11 WHO title sanitisation (CodeQL js/incomplete-multi-character-sanitization #9)", () => {
  it("strips WHO highlight markup and keeps terminology", () => {
    expect(icd11TitleToPlainText("<em class='found'>Malaria</em> due to Plasmodium falciparum")).toBe(
      "Malaria due to Plasmodium falciparum",
    )
    expect(icd11TitleToPlainText("Crohn disease &amp; colitis")).toBe("Crohn disease & colitis")
  })

  it.each([
    "<scr<script>ipt>alert(1)</script>",
    "<<script>script>alert(1)<</script>/script>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "<img src=x onerror=alert(1)>Sepsis",
    "Sepsis<svg/onload=alert(1)",
  ])("never yields an HTML element for %s", (payload) => {
    const out = icd11TitleToPlainText(payload)
    expect(out).not.toMatch(/[<>]/)
  })

  it("is linear on adversarial input", () => {
    const start = Date.now()
    icd11TitleToPlainText("<".repeat(100_000) + ">".repeat(100_000))
    expect(Date.now() - start).toBeLessThan(200)
  })

  it("sanitises titles returned by the WHO search API", async () => {
    let call = 0
    const result = await searchWhoIcd11("malaria", {
      env: { WHO_ICD11_CLIENT_ID: "id", WHO_ICD11_CLIENT_SECRET: "secret" },
      fetchImpl: async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
        return new Response(
          JSON.stringify({
            destinationEntities: [
              { theCode: "1F40", title: "<em class='found'>Malaria</em><script>alert(1)</script>", id: "http://id.who.int/icd/release/11/mms/1" },
            ],
          }),
          { status: 200 },
        )
      },
    })
    expect(result.source).toBe("who")
    expect(result.hits[0]?.title).toBe("Malariaalert(1)")
    expect(result.hits[0]?.title).not.toMatch(/[<>]/)
  })
})
