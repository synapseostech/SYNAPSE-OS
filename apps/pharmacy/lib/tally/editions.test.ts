import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import {
  TALLY_EDITIONS,
  TALLY_EDITION_PROFILES,
  editionDisclosure,
  editionProblems,
  editionProfile,
  normaliseTallyEdition,
} from "./editions"

describe("Tally editions", () => {
  it("names exactly the two supported target editions", () => {
    expect([...TALLY_EDITIONS]).toEqual(["prime", "erp9"])
    expect(Object.keys(TALLY_EDITION_PROFILES).sort()).toEqual(["erp9", "prime"])
  })

  it("gives every edition a gateway setup, extraction requirements and a caveat", () => {
    for (const edition of TALLY_EDITIONS) {
      const profile = TALLY_EDITION_PROFILES[edition]
      expect(profile.label.length).toBeGreaterThan(0)
      expect(profile.executables.length).toBeGreaterThan(0)
      expect(profile.httpPort).toBe(9000)
      expect(profile.gatewaySetup.length).toBeGreaterThan(0)
      expect(profile.extractionRequirements.length).toBeGreaterThan(0)
      expect(profile.reviewCaveats.length).toBeGreaterThan(0)
    }
  })

  it("claims no edition has been verified against a real installation", () => {
    // The type allows a date here, so this test is the guard that keeps a
    // label from being presented as compatibility evidence.
    for (const edition of TALLY_EDITIONS) {
      expect(TALLY_EDITION_PROFILES[edition].verifiedOn).toBeNull()
      expect(TALLY_EDITION_PROFILES[edition].evidenceUrl).toBeNull()
    }
  })

  it("never lets a verification date stand without its acceptance record", () => {
    // `verifiedOn` is a claim; `evidenceUrl` is the evidence. A profile that
    // sets one and not the other is either an unbacked claim or a record
    // nothing points at, so this fails before the review can show it.
    const repoRoot = join(__dirname, "../../../..")
    for (const edition of TALLY_EDITIONS) {
      const profile = TALLY_EDITION_PROFILES[edition]
      expect(
        profile.verifiedOn === null,
        `${edition}: verifiedOn and evidenceUrl must both be set or both be null`,
      ).toBe(profile.evidenceUrl === null)

      if (profile.verifiedOn === null) continue

      const record = join(repoRoot, profile.evidenceUrl!)
      expect(existsSync(record), `${edition}: ${profile.evidenceUrl} must exist`).toBe(true)
      const text = readFileSync(record, "utf8")
      expect(text, `${edition}: the record must name the run date`).toContain(profile.verifiedOn)
      expect(text, `${edition}: the record must name the edition`).toContain(profile.label)
    }
  })

  it("never forwards port 9000 to the internet in any gateway setup", () => {
    for (const edition of TALLY_EDITIONS) {
      const setup = TALLY_EDITION_PROFILES[edition].gatewaySetup.join(" ")
      expect(setup).toContain("Never forward port 9000")
    }
  })
})

describe("normaliseTallyEdition", () => {
  it("accepts the names the bridge and operators use", () => {
    expect(normaliseTallyEdition("prime")).toBe("prime")
    expect(normaliseTallyEdition("TallyPrime")).toBe("prime")
    expect(normaliseTallyEdition("tally prime")).toBe("prime")
    expect(normaliseTallyEdition("erp9")).toBe("erp9")
    expect(normaliseTallyEdition("Tally.ERP 9")).toBe("erp9")
    expect(normaliseTallyEdition("  TALLY_ERP-9 ")).toBe("erp9")
  })

  it("records anything it cannot place as unknown rather than guessing", () => {
    expect(normaliseTallyEdition(undefined)).toBe("unknown")
    expect(normaliseTallyEdition(null)).toBe("unknown")
    expect(normaliseTallyEdition("")).toBe("unknown")
    expect(normaliseTallyEdition("tally")).toBe("unknown")
    expect(normaliseTallyEdition("erp8")).toBe("unknown")
    expect(normaliseTallyEdition(9)).toBe("unknown")
    expect(normaliseTallyEdition({ edition: "prime" })).toBe("unknown")
  })
})

describe("editionProfile", () => {
  it("returns the profile for a target edition and null for unknown", () => {
    expect(editionProfile("prime")?.label).toBe("TallyPrime")
    expect(editionProfile("erp9")?.label).toBe("Tally.ERP 9")
    expect(editionProfile("unknown")).toBeNull()
  })
})

describe("editionDisclosure", () => {
  it("carries the label, an unverified state and the caveat", () => {
    const disclosure = editionDisclosure("prime")
    expect(disclosure.edition).toBe("prime")
    expect(disclosure.label).toBe("TallyPrime")
    expect(disclosure.verified).toBe(false)
    expect(disclosure.evidenceUrl).toBeNull()
    expect(disclosure.caveats).toEqual(TALLY_EDITION_PROFILES.prime.reviewCaveats)
  })

  it("says plainly when the edition is unknown", () => {
    const disclosure = editionDisclosure("unknown")
    expect(disclosure.label).toBe("Unrecognised edition")
    expect(disclosure.verified).toBe(false)
    expect(disclosure.evidenceUrl).toBeNull()
    expect(disclosure.caveats.length).toBeGreaterThan(0)
  })
})

describe("editionProblems", () => {
  it("warns that a known edition is unverified, without blocking", () => {
    const problems = editionProblems("erp9")
    expect(problems).toHaveLength(1)
    expect(problems[0]?.code).toBe("TALLY_EDITION_UNVERIFIED")
    expect(problems[0]?.severity).toBe("warning")
    expect(problems[0]?.message).toContain("Tally.ERP 9")
  })

  it("warns when the edition could not be read", () => {
    const problems = editionProblems("unknown")
    expect(problems).toHaveLength(1)
    expect(problems[0]?.code).toBe("TALLY_EDITION_UNKNOWN")
    expect(problems[0]?.severity).toBe("warning")
  })

  it("never returns a blocking problem, because the numbers are judged on their own", () => {
    for (const edition of [...TALLY_EDITIONS, "unknown"] as const) {
      expect(editionProblems(edition).every((p) => p.severity !== "blocking")).toBe(true)
    }
  })
})

describe("the bridge and the portal agree on install paths", () => {
  it("lists the same executables the Windows bridge probes, and classifies them the same", async () => {
    // The real bridge module, executed rather than mirrored: a copy of the table
    // in this test would drift exactly the way the two lists would.
    const modulePath = join(__dirname, "../../../tally-bridge/src/bridge.mjs")
    const bridge = (await import(pathToFileURL(modulePath).href)) as {
      TALLY_DEFAULT_EXECUTABLES: Array<{ edition: string; executable: string }>
      tallyEditionFromExecutable: (executable: unknown) => string
    }
    const entries = bridge.TALLY_DEFAULT_EXECUTABLES
    expect(entries.length).toBeGreaterThan(0)

    const portal = TALLY_EDITIONS.flatMap((edition) =>
      TALLY_EDITION_PROFILES[edition].executables.map((executable) => ({ edition, executable })),
    )
    expect(portal).toEqual(entries)

    for (const entry of entries) {
      expect(bridge.tallyEditionFromExecutable(entry.executable)).toBe(entry.edition)
    }
  })
})
