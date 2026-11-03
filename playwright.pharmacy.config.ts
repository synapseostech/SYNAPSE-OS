import { defineConfig, devices } from "playwright/test"
import { vercelProtectionBypassHeaders } from "./scripts/e2e-target.mjs"
import { resolvePharmacyTarget } from "./scripts/e2e-pharmacy-target.mjs"

// Throws on a missing or production target, before any browser is launched.
const target = resolvePharmacyTarget()

// "chrome" drives the installed browser (the one the cut-over accepts);
// "chromium" uses Playwright's own download. Procedure:
// docs/pharmacy/PHARMACY_WINDOWS_ACCEPTANCE.md.
// CHROMIUM_EXECUTABLE points Playwright at a build it did not download, for an
// offline CI image or a host whose browser lives outside the Playwright cache.
const chromiumExecutable = (process.env.SYNAPSE_PHARMACY_E2E_CHROMIUM_EXECUTABLE ?? "").trim()
const chromeChannel = chromiumExecutable
  ? undefined
  : ((process.env.SYNAPSE_PHARMACY_E2E_CHROME_CHANNEL ?? "chrome") as "chrome" | "chromium")

console.log(`PHARMACY E2E MODE: ${target.mode === "remote" ? "REMOTE" : "LOCAL"}`)
console.log(`PHARMACY E2E BASE URL: ${target.baseURL}`)
console.log(`PHARMACY E2E CHROME: ${chromiumExecutable || chromeChannel}`)

export default defineConfig({
  testDir: "./e2e-pharmacy",
  outputDir: "test-results/pharmacy",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/pharmacy-acceptance.json" }],
  ],
  use: {
    baseURL: target.baseURL,
    extraHTTPHeaders: vercelProtectionBypassHeaders(),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  webServer: target.startWebServer
    ? {
        command: target.startCommand,
        url: `${target.baseURL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        stdout: "pipe",
        stderr: "pipe",
      }
    : undefined,
  projects: [
    {
      // The cut-over accepts Chrome, so drive the installed browser rather than
      // a bundled copy. Set the channel to "chromium" on a host where the only
      // Chrome is the one Playwright downloaded.
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: chromeChannel,
        launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
      },
    },
    {
      // Edge is the second accepted browser. The runner probes for the installed
      // channel and only then selects this project, so a host without Edge
      // records "NOT RUN" instead of a launch error.
      name: "edge",
      use: { ...devices["Desktop Edge"], channel: "msedge" },
    },
  ],
})
