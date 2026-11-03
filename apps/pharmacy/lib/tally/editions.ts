/**
 * TallyPrime and Tally.ERP 9 as two named migration targets.
 *
 * Both editions serve the same XML/TDL export interface on the local gateway,
 * so the request envelope and the parser are shared. What differs is what an
 * operator must do to make that gateway reachable, and what a review is allowed
 * to claim about the data it read. This module is the single place either is
 * stated.
 *
 * No edition has been exercised against a real installation from this
 * codebase. `verifiedOn` and `evidenceUrl` are therefore `null` on every
 * profile: a caller cannot present the edition label as compatibility
 * evidence, and the review says so. The synthetic XML in the test suite is a
 * contract fixture, not evidence that either product emits this shape.
 */

export const TALLY_EDITIONS = ["prime", "erp9"] as const

export type TallyTargetEdition = (typeof TALLY_EDITIONS)[number]

/** `unknown` is recorded as itself; it is never promoted to a target edition. */
export type TallyEdition = TallyTargetEdition | "unknown"

const GATEWAY_PORT = 9000

export type TallyEditionProfile = {
  edition: TallyTargetEdition
  label: string
  /** Install paths the bridge probes, in order. Kept in step with the bridge by test. */
  executables: readonly string[]
  /** The local XML/HTTP gateway the bridge reads. */
  httpPort: number
  /** What the operator must complete on the Tally machine before an extraction. */
  gatewaySetup: readonly string[]
  /** What an export must contain for the extraction to be judged complete. */
  extractionRequirements: readonly string[]
  /** What the review must not imply about this edition. */
  reviewCaveats: readonly string[]
  /** A date only when a real installation was exercised from this codebase. */
  verifiedOn: string | null
  /**
   * Repo-relative path to the acceptance record for that run. Required whenever
   * `verifiedOn` is set: the date alone is a claim, the record is the evidence.
   * `editions.test.ts` fails if the two disagree or the file is missing.
   */
  evidenceUrl: string | null
}

const SHARED_GATEWAY_STEPS = [
  "Open exactly one company in Tally. The bridge reads the company that is already open; it cannot select one, type a password, or open a data folder.",
  `Enable Tally's local XML/HTTP gateway on port ${GATEWAY_PORT}. Confirm something listens: Get-NetTCPConnection -State Listen -LocalPort ${GATEWAY_PORT}.`,
  "Keep the gateway on loopback or the private LAN with a Windows firewall rule scoped to the bridge computer. Never forward port 9000 to the internet.",
  "Keep the company open for the whole extraction. A closed company or a changed period makes Tally answer the next range with an error rather than data.",
]

const SHARED_EXTRACTION_REQUIREMENTS = [
  "The masters export must carry <TALLYMESSAGE> records for ledgers and stock items, with each ledger's CLOSINGBALANCE when the export period ends on the cut-over date.",
  "The Day Book export must return one <VOUCHER> per voucher inside the requested SVFROMDATE–SVTODATE window, and nothing dated outside it.",
  "The export must name the company the portal pinned. A file for another company is refused rather than imported.",
  "Anything the parser cannot read is reported as a blocking exception. It is never guessed at or silently dropped.",
]

export const TALLY_EDITION_PROFILES: Record<TallyTargetEdition, TallyEditionProfile> = {
  prime: {
    edition: "prime",
    label: "TallyPrime",
    executables: [
      "C:\\Program Files\\TallyPrime\\tally.exe",
      "C:\\Program Files (x86)\\TallyPrime\\tally.exe",
    ],
    httpPort: GATEWAY_PORT,
    gatewaySetup: [
      "Open one company, then F1 → Settings → Advanced Configuration and turn the HTTP/gateway server on for port 9000.",
      ...SHARED_GATEWAY_STEPS,
    ],
    extractionRequirements: SHARED_EXTRACTION_REQUIREMENTS,
    reviewCaveats: [
      "No TallyPrime installation has been exercised from this codebase. This review reports what the export contained; it is not confirmation that TallyPrime emits every field this screen reads.",
    ],
    verifiedOn: null,
    evidenceUrl: null,
  },
  erp9: {
    edition: "erp9",
    label: "Tally.ERP 9",
    executables: [
      "C:\\Tally.ERP9\\tally.exe",
      "C:\\Program Files\\Tally.ERP9\\tally.exe",
    ],
    httpPort: GATEWAY_PORT,
    gatewaySetup: [
      "Open one company, then reach the HTTP/gateway setting from the F1 configuration menu and turn it on for port 9000. On ERP 9 releases the setting sits in the F1 configuration menu rather than a separate Connectivity page.",
      ...SHARED_GATEWAY_STEPS,
    ],
    extractionRequirements: SHARED_EXTRACTION_REQUIREMENTS,
    reviewCaveats: [
      "No Tally.ERP 9 installation has been exercised from this codebase, and ERP 9 is the predecessor line to TallyPrime. This review reports what the export contained; it is not a compatibility statement for ERP 9.",
    ],
    verifiedOn: null,
    evidenceUrl: null,
  },
}

/** What the operator or the bridge reported, reduced to a known value. */
export function normaliseTallyEdition(value: unknown): TallyEdition {
  if (typeof value !== "string") return "unknown"
  const plain = value.trim().toLowerCase().replace(/[\s._-]+/g, "")
  if (plain === "prime" || plain === "tallyprime") return "prime"
  if (plain === "erp9" || plain === "tallyerp9") return "erp9"
  return "unknown"
}

export function editionProfile(edition: TallyEdition): TallyEditionProfile | null {
  return edition === "unknown" ? null : TALLY_EDITION_PROFILES[edition]
}

export type TallyEditionDisclosure = {
  edition: TallyEdition
  label: string
  /** Always false until a profile carries `verifiedOn`. */
  verified: boolean
  /** The acceptance record behind `verified`, or null while unverified. */
  evidenceUrl: string | null
  caveats: string[]
}

/** What the review and the apply evidence must say about the edition. */
export function editionDisclosure(edition: TallyEdition): TallyEditionDisclosure {
  const profile = editionProfile(edition)
  if (!profile) {
    return {
      edition: "unknown",
      label: "Unrecognised edition",
      verified: false,
      evidenceUrl: null,
      caveats: [
        "The extraction did not report which Tally edition produced this export, so no edition-specific claim is made about it.",
      ],
    }
  }
  return {
    edition,
    label: profile.label,
    verified: profile.verifiedOn !== null,
    evidenceUrl: profile.evidenceUrl,
    caveats: [...profile.reviewCaveats],
  }
}

export type TallyEditionProblem = {
  code: string
  message: string
  severity: "blocking" | "warning"
}

/**
 * Problems the review must show before Apply. Neither is blocking: an
 * unverified edition does not make the numbers wrong, it makes the claim
 * weaker, and the operator is told exactly that.
 */
export function editionProblems(edition: TallyEdition): TallyEditionProblem[] {
  const profile = editionProfile(edition)
  if (!profile) {
    return [
      {
        code: "TALLY_EDITION_UNKNOWN",
        message:
          "This extraction did not report which Tally edition it read. The migration is still reviewable, but no edition-specific compatibility is claimed.",
        severity: "warning",
      },
    ]
  }
  if (profile.verifiedOn !== null) return []
  return [
    {
      code: "TALLY_EDITION_UNVERIFIED",
      message: `This export was read from ${profile.label}. That edition has not been tested against a real installation by this codebase, so the import is reviewed on its own numbers rather than on a compatibility claim.`,
      severity: "warning",
    },
  ]
}
