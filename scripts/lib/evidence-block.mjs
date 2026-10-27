/**
 * evidence-block.mjs — the single source of truth for the generated figures
 * block embedded in the audit documents.
 *
 * collect-evidence.mjs writes this block between `<!-- evidence:begin -->` and
 * `<!-- evidence:end -->` in the audit documents; evidence-drift.test.mjs
 * asserts the block in each document equals the rendered output of the current
 * artifacts/readiness/evidence.json exactly. No prose may restate these
 * figures by hand.
 */

export const EVIDENCE_BEGIN = "<!-- evidence:begin -->"
export const EVIDENCE_END = "<!-- evidence:end -->"

/** Render the evidence block (including a leading and trailing newline). */
export function renderEvidenceBlock(evidence) {
  const line = (k, v) => `${k}: ${v ?? "null"}`
  const suites = evidence.suites ?? {}
  const lines = [
    line("source", "artifacts/readiness/evidence.json"),
    line("timestamp", evidence.timestamp),
    line("git.branch", evidence.git?.branch),
    line("git.head", evidence.git?.head),
    line("migrationCount", evidence.migrationCount?.count),
    line("suites.rls-tenant-isolation.tests", suites["rls-tenant-isolation"]?.tests),
    line("suites.security-gates.banner", suites["security-gates"]?.banner),
    line("suites.security-gates.exitCode", suites["security-gates"]?.exitCode),
    line("suites.hardening.tests", suites.hardening?.tests),
    line("suites.tenancy.tests", suites.tenancy?.tests),
    line("suites.workflow-safety.tests", suites["workflow-safety"]?.tests),
    line("suites.rls-matrix.tests", suites["rls-matrix"]?.tests),
    line("dbAcl.definerFunctions", evidence.dbAcl?.definerFunctions),
    line("dbAcl.publicGrants", evidence.dbAcl?.publicGrants),
    line("dbAcl.possibleImplicitPublic", evidence.dbAcl?.possibleImplicitPublic),
    line("dbAcl.liveCheck", evidence.dbAcl?.liveCheck),
    line("routeIntegrity.pages", evidence.routeIntegrity?.pages),
    line("routeIntegrity.navLinks", evidence.routeIntegrity?.navLinks),
    line("routeIntegrity.roadmap", evidence.routeIntegrity?.roadmap),
    line("disposableDb.result", evidence.disposableDb?.result),
  ]
  return "\n" + lines.join("\n") + "\n"
}

/** Replace the block between the markers. Throws if the markers are absent. */
export function replaceEvidenceBlock(docText, block) {
  const start = docText.indexOf(EVIDENCE_BEGIN)
  const finish = docText.indexOf(EVIDENCE_END)
  if (start === -1 || finish === -1 || finish < start) {
    throw new Error(`document is missing ${EVIDENCE_BEGIN} / ${EVIDENCE_END} markers`)
  }
  return docText.slice(0, start + EVIDENCE_BEGIN.length) + block + docText.slice(finish)
}

/** Extract the current block (between the markers), or null when absent. */
export function extractEvidenceBlock(docText) {
  const start = docText.indexOf(EVIDENCE_BEGIN)
  const finish = docText.indexOf(EVIDENCE_END)
  if (start === -1 || finish === -1 || finish < start) return null
  return docText.slice(start + EVIDENCE_BEGIN.length, finish)
}
