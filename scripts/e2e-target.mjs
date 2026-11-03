import { pathToFileURL } from "node:url"

export function resolvePlaywrightTarget(env = process.env) {
  const remote = String(env.PLAYWRIGHT_BASE_URL || env.SYNAPSE_E2E_BASE_URL || "").trim()
  if (remote) {
    const url = new URL(remote)
    return {
      mode: "remote",
      baseURL: remote,
      host: url.hostname,
      startWebServer: false,
    }
  }
  return {
    mode: "local",
    baseURL: "http://127.0.0.1:3001",
    host: "127.0.0.1",
    startWebServer: true,
  }
}

export const resolveE2eTarget = resolvePlaywrightTarget

/** @returns {Record<string, string>} */
export function vercelProtectionBypassHeaders(env = process.env) {
  const secret = String(env.SYNAPSE_E2E_VERCEL_BYPASS || "").trim()
  if (!secret) return {}
  return {
    "x-vercel-protection-bypass": secret,
    "x-vercel-set-bypass-cookie": "true",
  }
}

export function logPlaywrightTarget(target = resolvePlaywrightTarget()) {
  console.log(`E2E MODE: ${target.mode === "remote" ? "REMOTE" : "LOCAL"}`)
  console.log(`E2E HOST: ${target.host}`)
  return target
}

export const logE2eTarget = logPlaywrightTarget

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) logPlaywrightTarget()
