type VercelDomainResponse = {
  name?: string;
  uid?: string;
  verified?: boolean;
  verification?: unknown[];
  error?: { message?: string; code?: string };
};

export type PharmacyDomainProvisioning = {
  configured: boolean;
  status: "default" | "manual_dns_required" | "dns_pending" | "verified" | "error";
  verified: boolean;
  vercelDomainId: string | null;
  verification: unknown[] | null;
  error: string | null;
};

const FALLBACK_PHARMACY_PROJECT_ID = "prj_CHbxKSy0pee2nieRVvQ3Rhyw4cnh";

function getVercelDomainConfig() {
  return {
    token: process.env.VERCEL_API_TOKEN ?? process.env.SYNAPSE_VERCEL_API_TOKEN ?? "",
    projectId:
      process.env.SYNAPSE_PHARMACY_VERCEL_PROJECT_ID ??
      process.env.SYNAPSE_VERCEL_PROJECT_ID ??
      process.env.VERCEL_PROJECT_ID ??
      FALLBACK_PHARMACY_PROJECT_ID,
    teamId: process.env.SYNAPSE_VERCEL_TEAM_ID ?? process.env.VERCEL_TEAM_ID ?? "team_IfLX69fKbBxupsNAtDVzF573",
  };
}

function endpoint(path: string, teamId: string) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

function missingTokenResult(): PharmacyDomainProvisioning {
  return {
    configured: false,
    status: "manual_dns_required",
    verified: false,
    vercelDomainId: null,
    verification: null,
    error: "Set VERCEL_API_TOKEN to provision pharmacy custom domains automatically.",
  };
}

function normalizeDomainResult(data: VercelDomainResponse, configured = true): PharmacyDomainProvisioning {
  const verified = Boolean(data.verified);
  return {
    configured,
    status: verified ? "verified" : "dns_pending",
    verified,
    vercelDomainId: data.uid ?? null,
    verification: Array.isArray(data.verification) ? data.verification : null,
    error: data.error?.message ?? null,
  };
}

async function vercelRequest(path: string, init: RequestInit = {}) {
  const { token, teamId } = getVercelDomainConfig();
  if (!token) {
    return { ok: false, status: 401, data: { error: { message: missingTokenResult().error ?? "" } } as VercelDomainResponse };
  }

  const response = await fetch(endpoint(path, teamId), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as VercelDomainResponse;
  return { ok: response.ok, status: response.status, data };
}

export async function getVercelProjectDomain(domain: string): Promise<PharmacyDomainProvisioning> {
  const { token, projectId } = getVercelDomainConfig();
  if (!token) return missingTokenResult();

  const result = await vercelRequest(`/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}`);
  if (!result.ok) {
    return {
      configured: true,
      status: "error",
      verified: false,
      vercelDomainId: null,
      verification: null,
      error: result.data.error?.message ?? `Vercel domain lookup failed with status ${result.status}.`,
    };
  }

  return normalizeDomainResult(result.data);
}

export async function provisionVercelProjectDomain(domain: string): Promise<PharmacyDomainProvisioning> {
  const { token, projectId } = getVercelDomainConfig();
  if (!token) return missingTokenResult();

  const addResult = await vercelRequest(`/v10/projects/${projectId}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });

  if (!addResult.ok && addResult.status !== 409) {
    return {
      configured: true,
      status: "error",
      verified: false,
      vercelDomainId: null,
      verification: null,
      error: addResult.data.error?.message ?? `Vercel domain provisioning failed with status ${addResult.status}.`,
    };
  }

  return getVercelProjectDomain(domain);
}

export async function verifyVercelProjectDomain(domain: string): Promise<PharmacyDomainProvisioning> {
  const { token, projectId } = getVercelDomainConfig();
  if (!token) return missingTokenResult();

  const verifyResult = await vercelRequest(`/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}/verify`, {
    method: "POST",
  });

  if (!verifyResult.ok) {
    return {
      configured: true,
      status: "error",
      verified: false,
      vercelDomainId: null,
      verification: null,
      error: verifyResult.data.error?.message ?? `Vercel domain verification failed with status ${verifyResult.status}.`,
    };
  }

  return normalizeDomainResult(verifyResult.data);
}
