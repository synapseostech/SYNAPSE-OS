import { NextResponse, type NextRequest } from "next/server";
import { facilitySlugFromHost, lookupActiveTenant, sanitizedTenantHeaders } from "./lib/tenant-routing";
import { verifyToken } from '@synapse/auth/tokens'
import { SESSION_COOKIE } from '@synapse/config/constants'
import { decideMutationOrigin, hasAuthCookie } from '@synapse/auth/mutation-origin'

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

type PharmacyDomainLookup = {
  tenant_id?: string | null;
};

type TenantLookup = {
  slug?: string | null;
};

function standalonePharmacyUrl(request: NextRequest, tenantSlug: string) {
  const origin = (process.env.NEXT_PUBLIC_PHARMACY_APP_URL ?? "https://pharm.synapseos.tech").replace(/\/$/, "");
  const target = new URL("/login", origin);
  target.searchParams.set("tenant", tenantSlug);

  const redirectTo = request.nextUrl.searchParams.get("redirectTo");
  if (redirectTo) target.searchParams.set("redirectTo", redirectTo);

  return target;
}

async function resolvePharmacyCustomDomain(hostname: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const profileUrl = new URL(`${supabaseUrl}/rest/v1/pharmacy_profiles`);
    profileUrl.searchParams.set("custom_domain", `eq.${hostname}`);
    profileUrl.searchParams.set("select", "tenant_id");
    profileUrl.searchParams.set("limit", "1");
    const profileResponse = await fetch(profileUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      cache: "no-store",
    });
    if (!profileResponse.ok) return null;
    const [profile] = (await profileResponse.json()) as PharmacyDomainLookup[];
    if (!profile?.tenant_id) return null;

    const tenantUrl = new URL(`${supabaseUrl}/rest/v1/tenants`);
    tenantUrl.searchParams.set("id", `eq.${profile.tenant_id}`);
    tenantUrl.searchParams.set("select", "slug");
    tenantUrl.searchParams.set("limit", "1");
    const tenantResponse = await fetch(tenantUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      cache: "no-store",
    });
    if (!tenantResponse.ok) return null;
    const [tenant] = (await tenantResponse.json()) as TenantLookup[];

    return {
      tenantId: profile.tenant_id,
      slug: tenant?.slug?.replace(/^pharm-/, "") ?? hostname,
    };
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function isSessionStored(token: string, userId: string): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return false;

  try {
    const tokenHash = await sha256Hex(token);
    const sessionUrl = new URL(`${supabaseUrl}/rest/v1/synapse_sessions`);
    sessionUrl.searchParams.set("token_hash", `eq.${tokenHash}`);
    sessionUrl.searchParams.set("select", "user_id,expires_at,revoked_at");
    sessionUrl.searchParams.set("limit", "1");

    const response = await fetch(sessionUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      cache: "no-store",
    });

    if (!response.ok) return false;
    const [session] = (await response.json()) as {
      user_id?: string | null;
      expires_at?: string | null;
      revoked_at?: string | null;
    }[];

    if (!session || session.user_id !== userId) return false;
    if (session.revoked_at) return false;
    if (!session.expires_at || new Date(session.expires_at) < new Date()) return false;
    return true;
  } catch {
    return false;
  }
}

async function hasSynapseSession(request: NextRequest): Promise<{ valid: boolean; tenantId?: string }> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return { valid: false }
  try {
    const payload = await verifyToken(token)
    const stored = await isSessionStored(token, payload.sub)
    if (!stored) return { valid: false }
    return { valid: true, tenantId: payload.tenant_id ?? undefined }
  } catch {
    return { valid: false }
  }
}
async function hasPlatformControlPlaneAccess(
  userId: string,
  profileRole: string | undefined,
  email: string | undefined
): Promise<boolean> {
  if (profileRole === "platform_admin" || profileRole === "platform_observer" || profileRole === "superadmin") {
    return true;
  }
  if (
    email &&
    ADMIN_EMAILS.length > 0 &&
    ADMIN_EMAILS.includes(email.toLowerCase())
  ) {
    return true;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return false;

  try {
    const url = new URL(`${supabaseUrl}/rest/v1/platform_memberships`);
    url.searchParams.set("user_id", `eq.${userId}`);
    url.searchParams.set("status", "eq.ACTIVE");
    url.searchParams.set("select", "id,expires_at");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      cache: "no-store",
    });
    if (!response.ok) return false;
    const [row] = (await response.json()) as { id?: string; expires_at?: string | null }[];
    if (!row?.id) return false;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return false;
    return true;
  } catch {
    return false;
  }
}

async function isTenantActive(tenantId: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return false;

  try {
    const tenantUrl = new URL(`${supabaseUrl}/rest/v1/tenants`);
    tenantUrl.searchParams.set("id", `eq.${tenantId}`);
    tenantUrl.searchParams.set("select", "is_active,status");
    tenantUrl.searchParams.set("limit", "1");
    const tenantResponse = await fetch(tenantUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      cache: "no-store",
    });
    if (!tenantResponse.ok) return false;
    const [tenant] = (await tenantResponse.json()) as { is_active?: boolean | null; status?: string }[];
    return tenant?.is_active === true && tenant.status === "active";
  } catch {
    return false;
  }
}

/** Process health probes — never rewrite under tenant/admin/demo shells; no DB/tenant gate. */
function isProcessHealthPath(pathname: string): boolean {
  return pathname === "/api/health/live" || pathname === "/api/ready";
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  const forwardedHeaders = sanitizedTenantHeaders(request.headers);
  const next = () => NextResponse.next({ request: { headers: forwardedHeaders } });
  const rewrite = (url: URL) => NextResponse.rewrite(url, { request: { headers: forwardedHeaders } });
  const isStatic = pathname.startsWith("/_next/") || (!/^\/(api|os)(?:\/|$)/.test(pathname) && /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2)$/.test(pathname));
  if (isStatic) return next();

  // Liveness/readiness must work on every host (www, admin, demo, facility, preview)
  // without tenant lookup, auth, or UI rewrites into /os|/platform|/demo|/pharmacy.
  if (isProcessHealthPath(pathname)) return next();

  const originDecision = decideMutationOrigin({
    method: request.method,
    host: request.headers.get('host'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    hasSessionCookie: hasAuthCookie(request.cookies.getAll().filter((c) => c.value).map((c) => c.name)),
  })
  if (!originDecision.allow) {
    return NextResponse.json({ error: 'cross_origin_mutation_blocked' }, { status: 403 })
  }

  const hostSlug = facilitySlugFromHost(hostname);
  // Root /os/:slug routes are also tenant-scoped. A tenant host may never select another path tenant.
  const pathSlug = pathname.match(/^\/os\/([^/]+)(?:\/|$)/)?.[1];
  if (hostSlug && pathSlug && pathSlug !== hostSlug) {
    return new NextResponse("Facility unavailable", { status: 404 });
  }
  const routedSlug = hostSlug ?? pathSlug;
  if (routedSlug) {
    const tenant = await lookupActiveTenant(routedSlug, {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    if (!tenant) return new NextResponse("Facility unavailable", { status: 404 });
    const session = await hasSynapseSession(request);
    if (session.valid && session.tenantId !== tenant.id) {
      return new NextResponse("Tenant access denied", { status: 403 });
    }
    forwardedHeaders.set("x-tenant-id", tenant.id);
    forwardedHeaders.set("x-tenant-slug", tenant.slug);
    forwardedHeaders.set("x-tenant-type", tenant.facility_type);
    forwardedHeaders.set("x-hospital-subdomain", tenant.slug);
    if (pathname === "/api" || pathname.startsWith("/api/")) return next();
    if (pathname === "/login" || pathname.startsWith("/invite/") || pathname === "/forgot-password" || pathname.startsWith("/reset-password")) return next();
    if (!session.valid) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    if (tenant.facility_type === "pharmacy") return NextResponse.redirect(standalonePharmacyUrl(request, tenant.slug));
    // Shared workspaces keep their native paths; only tenant shell paths are rewritten.
    if (!hostSlug || pathSlug || /^\/(lab|hospital|admin|doctor|nurse|encounter|patient)(?:\/|$)/.test(pathname)) return next();
    return rewrite(new URL(`/os/${tenant.slug}${pathname === "/" ? "" : pathname}`, request.url));
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) return next();

  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const parts = hostname.split(".");
  const rawSubdomain = parts[0] ?? "";

  const isSynapseManagedDomain =
    hostname === "synapseos.tech" ||
    hostname === "www.synapseos.tech" ||
    hostname.endsWith(".synapseos.tech");

  const isRootDomain =
    hostname.startsWith("synapseos.") ||
    hostname.startsWith("www.") ||
    isLocal ||
    hostname.endsWith(".vercel.app");

  const subdomain = isRootDomain ? (isLocal ? request.nextUrl.searchParams.get("subdomain") ?? "" : "") : rawSubdomain;
  if (["api", "status", "docs"].includes(subdomain)) return new NextResponse("Not found", { status: 404 });

  if (!isLocal && !hostname.endsWith(".vercel.app") && !isSynapseManagedDomain) {
    const pharmacyDomain = await resolvePharmacyCustomDomain(hostname);
    if (pharmacyDomain) {
      return NextResponse.redirect(standalonePharmacyUrl(request, pharmacyDomain.slug));
    }
  }

  // ── DEMO subdomain ────────────────────────────────────────────────
  // Public CTA HTML is prerendered as /demo/login. On this host that
  // double-prefixes to /demo/demo/login (404). Strip /demo and rewrite.
  // Health/ready must never be rewritten under /demo/*.
  if (subdomain === "demo") {
    if (pathname === "/api" || pathname.startsWith("/api/")) return next();
    const url = request.nextUrl.clone();
    if (pathname === "/demo" || pathname.startsWith("/demo/")) {
      url.pathname = pathname.replace(/^(?:\/demo)+/, "") || "/";
      return NextResponse.redirect(url);
    }
    url.pathname = `/demo${pathname === "/" ? "" : pathname}`;
    return rewrite(url);
  }

  // ── APP subdomain: consumer health portal ───────────────────────────
  if (subdomain === "app") {
    if (pathname === "/" || pathname === "") {
      const url = request.nextUrl.clone();
      url.pathname = "/app-portal";
      return rewrite(url);
    }
    return next();
  }

  // ── ADMIN subdomain: email-gated ──────────────────────────────────
  if (subdomain === "admin") {
    // API probes and BFF routes must not be rewritten under /platform/*.
    if (pathname === "/api" || pathname.startsWith("/api/")) return next();
    // Invite redemption is public — don't rewrite or gate it
    if (pathname.startsWith("/invite/") || pathname.startsWith("/platform/invite/")) {
      return next();
    }

    const platformPath = pathname.startsWith("/platform")
      ? pathname
      : `/platform${pathname === "/" ? "" : pathname}`;
    const isAuthPage =
      platformPath === "/platform/login" ||
      platformPath === "/platform/mfa" ||
      platformPath === "/platform/mfa-verify" ||
      platformPath.startsWith("/platform/invite/");

    const { valid: synapseValid } = await hasSynapseSession(request)

    if (synapseValid && !isAuthPage) {
      const token = request.cookies.get(SESSION_COOKIE)?.value;
      if (token) {
        try {
          const payload = await verifyToken(token);
          const allowed = await hasPlatformControlPlaneAccess(
            payload.sub,
            payload.role,
            typeof payload.email === "string" ? payload.email : undefined
          );
          if (!allowed) {
            const url = request.nextUrl.clone();
            url.pathname = "/platform/login";
            url.searchParams.set("error", "unauthorized");
            return rewrite(url);
          }
        } catch {
          const url = request.nextUrl.clone();
          url.pathname = "/platform/login";
          return rewrite(url);
        }
      }
    }

    if (!synapseValid && !isAuthPage) {
      // Check for MFA-pending cookie — user completed OTP but not TOTP yet
      const mfaPending = request.cookies.get('synapse_mfa_pending')?.value
      const url = request.nextUrl.clone()
      if (mfaPending) {
        // Determine if user needs to set up or just verify TOTP.
        // We can't decrypt the JWT in middleware (Edge), so redirect to mfa-verify.
        // The route itself will redirect to mfa-setup if enrollment is missing.
        url.pathname = '/platform/mfa-verify'
      } else {
        url.pathname = '/platform/login'
      }
      return rewrite(url)
    }

    const url = request.nextUrl.clone();
    url.pathname = platformPath;
    return rewrite(url);
  }

  // ── LAB subdomain: product marketing + lab workspace entry ───────
  // Authenticated lab workspaces remain under facility hosts / /lab/* routes.
  // lab.synapseos.tech is the canonical Lab product surface (marketing + login CTA).
  if (subdomain === "lab") {
    if (pathname === "/api" || pathname.startsWith("/api/")) return next();
    if (pathname === "/login" || pathname.startsWith("/invite/")) return next();
    if (pathname.startsWith("/products/lab") || pathname.startsWith("/book-meeting") || pathname.startsWith("/pricing") || pathname.startsWith("/contact")) {
      return next();
    }
    if (pathname === "/" || pathname === "") {
      const url = request.nextUrl.clone();
      url.pathname = "/products/lab";
      return rewrite(url);
    }
    // Do not rewrite authenticated clinical /lab/* tools onto the product host.
    if (pathname === "/lab" || pathname.startsWith("/lab/")) {
      const url = request.nextUrl.clone();
      url.pathname = "/products/lab";
      return NextResponse.redirect(url);
    }
    return next();
  }

  // ── PHARM subdomain: standalone pharmacy app ─────────────────────
  if (subdomain === "pharm") {
    // OS health/ready APIs are not Pharmacy portal pages.
    if (pathname === "/api" || pathname.startsWith("/api/")) return next();
    // Invite redemption is public — no auth, no rewrite
    if (pathname.startsWith("/invite/")) {
      return next();
    }

    const { valid: pharmSessionValid } = await hasSynapseSession(request);
    const isPharmLoginPage = pathname === "/login";

    if (!pharmSessionValid && !isPharmLoginPage) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return rewrite(url);
    }

    // Rewrite to /pharmacy/* routes
    const pharmPath =
      pathname === "/" || pathname === "/login"
        ? "/pharmacy"
        : pathname.startsWith("/pharmacy")
        ? pathname
        : `/pharmacy${pathname}`;
    const url = request.nextUrl.clone();
    url.pathname = pharmPath;
    return rewrite(url);
  }

  // ── PHARM-{SLUG} subdomain: tenant-specific redirect ─────────────
  if (subdomain.startsWith("pharm-")) {
    const pharmacySlug = subdomain.replace(/^pharm-/, "");
    return NextResponse.redirect(standalonePharmacyUrl(request, `pharm-${pharmacySlug}`));
  }

  if (subdomain && subdomain !== "www" && subdomain !== "synapseos") {
    return new NextResponse("Facility unavailable", { status: 404 });
  }

  const { valid: synapseValid, tenantId: synapseTenantId } = await hasSynapseSession(request)

  const isProtected =
    pathname.startsWith("/os/") ||
    pathname.startsWith("/doctor/") ||
    pathname.startsWith("/nurse/") ||
    pathname.startsWith("/encounter/") ||
    pathname.startsWith("/lab/") ||
    pathname.startsWith("/radiology/") ||
    pathname.startsWith("/pharmacy/") ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/hospital/") ||
    pathname.startsWith("/patient/");

  if (isProtected && !synapseValid) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isProtected && synapseValid && synapseTenantId) {
    const tenantActive = await isTenantActive(synapseTenantId);
    if (!tenantActive) {
      return NextResponse.redirect(new URL("/login?error=account_inactive", request.url));
    }
  }

  return next();
}

export const config = {
  matcher: ["/:path*"],
};
