import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
const acceptance = readFileSync(join(root, ".github/workflows/os-e2e-acceptance.yml"), "utf8")
const helpers = readFileSync(join(root, "e2e/os-helpers.ts"), "utf8")
const seed = readFileSync(join(root, "scripts/seed-e2e-os-fixture.ts"), "utf8")
const playwright = readFileSync(join(root, "playwright.config.ts"), "utf8")

test("pull_request CI never receives a production service-role key", () => {
  assert.doesNotMatch(ci, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.doesNotMatch(ci, /SUPABASE_DB_URL/)
  assert.doesNotMatch(ci, /SYNAPSE_E2E_FIXED_OTP/)
  assert.doesNotMatch(ci, /SYNAPSE_E2E_VERCEL_BYPASS/)
})

test("Windows Tally bridge tests are a required Node 22 CI gate", () => {
  const windowsJob = ci.match(/  tally-bridge-windows:\n([\s\S]*?)\n  required:/)
  assert.ok(windowsJob, "Could not find the Windows Tally bridge job")
  assert.match(windowsJob[1], /runs-on: windows-latest/)
  assert.match(windowsJob[1], /node-version: '22'/)
  assert.match(windowsJob[1], /npm test --workspace @synapse\/tally-bridge/)
  assert.match(ci, /needs: \[verify, tally-bridge-windows\]/)
  assert.match(ci, /needs\['tally-bridge-windows'\]\.result/)
})

test("privileged hospital E2E runs only from a protected workflow on an exact SHA", () => {
  assert.doesNotMatch(acceptance, /pull_request:/)
  assert.match(acceptance, /environment:\s+production-acceptance/)
  assert.match(acceptance, /workflow_dispatch:/)
  assert.match(acceptance, /EXPECTED_SHA/)
  assert.match(acceptance, /Refusing to start localhost/)
})

test("Playwright helpers do not plant OTPs or hardcode a reusable code", () => {
  assert.doesNotMatch(helpers, /plantKnownOtp/)
  assert.doesNotMatch(helpers, /246801/)
  assert.doesNotMatch(helpers, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.match(helpers, /SYNAPSE_E2E_FIXED_OTP/)
  assert.match(helpers, /expectAuthenticatedWorkspace/)
  assert.doesNotMatch(helpers, /gmail\.com/i)
  assert.match(helpers, /reception\.e2e@synapseos\.invalid/)
})

test("acceptance workflow uses minimized secret surface", () => {
  // Browser step should not have privileged database or JWT secrets
  const browserStepMatch = acceptance.match(/- name: Hospital Golden Journey[\s\S]*?(?=\n      - name:|\njobs:|\n$)/)
  assert.ok(browserStepMatch, "Could not find Hospital Golden Journey step")
  const browserStep = browserStepMatch[0]
  assert.doesNotMatch(browserStep, /SYNAPSE_JWT_SECRET/)
  assert.doesNotMatch(browserStep, /SYNAPSE_E2E_JWT_SECRET/)
  assert.doesNotMatch(browserStep, /NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  assert.doesNotMatch(browserStep, /SYNAPSE_E2E_ANON_KEY/)
  assert.doesNotMatch(browserStep, /SUPABASE_SERVICE_ROLE_KEY/)
  
  // Browser step should have only what it needs
  assert.match(browserStep, /SYNAPSE_E2E_BASE_URL/)
  assert.match(browserStep, /SYNAPSE_E2E_EMAIL/)
  assert.match(browserStep, /SYNAPSE_E2E_PASSWORD/)
  assert.match(browserStep, /SYNAPSE_E2E_FIXED_OTP/)
  assert.match(browserStep, /SYNAPSE_E2E_VERCEL_BYPASS/)
  
  // Seed step should have database credentials
  const seedStepMatch = acceptance.match(/- name: Seed synthetic OS fixtures[\s\S]*?(?=\n      - name:)/)
  assert.ok(seedStepMatch, "Could not find Seed synthetic OS fixtures step")
  const seedStep = seedStepMatch[0]
  assert.match(seedStep, /SYNAPSE_E2E_SUPABASE_URL/)
  assert.match(seedStep, /SYNAPSE_E2E_SERVICE_ROLE_KEY/)
  assert.match(seedStep, /SYNAPSE_E2E_PASSWORD/)
  assert.match(seedStep, /SYNAPSE_E2E_SEED/)
  
  // Preflight doctor should exist
  assert.match(acceptance, /e2e:acceptance:doctor/)
})

test("seed uses production bcrypt hashing and fail-closed synthetic slugs", () => {
  assert.match(seed, /hashPassword/)
  assert.match(seed, /verifyPassword/)
  assert.doesNotMatch(seed, /createHash\(/)
  assert.doesNotMatch(seed, /sha256/i)
  assert.match(seed, /SYNAPSE_E2E_SEED/)
  assert.match(seed, /synapse-e2e-hospital/)
  assert.doesNotMatch(seed, /qfqakzmjatszisuqjwon/)
})

test("Playwright webServer starts only for the canonical local target", () => {
  assert.match(playwright, /logPlaywrightTarget/)
  assert.match(playwright, /target\.startWebServer/)
  assert.match(playwright, /vercelProtectionBypassHeaders/)
})
