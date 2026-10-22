/**
 * List pharmacy tenants and optionally provision a demo pharmacy for testing.
 * Usage:
 *   node scripts/pharmacy-test-setup.mjs list
 *   node scripts/pharmacy-test-setup.mjs provision --email you@example.com --name "Care Plus Pharmacy"
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* optional file */
  }
}

loadEnv("apps/web/.env.local");
loadEnv("apps/pharmacy/.env.local");

const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function rest(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(typeof data === "object" && data?.message ? data.message : text || res.statusText);
  return data;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function inspect(tenantId) {
  const [tenant] = await rest(`tenants?id=eq.${tenantId}&select=*&limit=1`);
  const profiles = await rest(`profiles?tenant_id=eq.${tenantId}&select=id,email,full_name,role,is_deleted,must_change_password`);
  const onboarding = await rest(`pharmacy_onboarding?tenant_id=eq.${tenantId}&select=*`);
  const stores = await rest(`pharmacy_stores?tenant_id=eq.${tenantId}&select=id,name,is_active`);
  const products = await rest(`pharmacy_products?tenant_id=eq.${tenantId}&select=id,name&limit=10`);
  console.log(JSON.stringify({ tenant, profiles, onboarding, stores, products }, null, 2));
}

async function listPharmacies() {
  const rows = await rest("tenants?facility_type=eq.pharmacy&select=id,name,slug,status,is_active,email,created_at&order=created_at.desc");
  console.log(JSON.stringify({ count: rows.length, pharmacies: rows }, null, 2));
  return rows;
}

function hashOtp(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function setTestOtp(email, otp = "123456") {
  const target = email.toLowerCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await rest("auth_otps", {
    method: "POST",
    body: JSON.stringify({
      channel: "email",
      target,
      otp_hash: hashOtp(otp),
      expires_at: expiresAt,
      used: false,
      attempts: 0,
    }),
  });
  console.log(JSON.stringify({ ok: true, email: target, otp, expiresAt }, null, 2));
}

async function ensureStore(tenantId) {
  const stores = await rest(`pharmacy_stores?tenant_id=eq.${tenantId}&select=id,name&limit=1`);
  if (stores?.length) {
    console.log(JSON.stringify({ ok: true, created: false, storeId: stores[0].id }, null, 2));
    return;
  }
  const [tenant] = await rest(`tenants?id=eq.${tenantId}&select=name&limit=1`);
  const created = await rest("pharmacy_stores", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      name: tenant?.name ? `${tenant.name} — Main Branch` : "Main Branch",
      store_type: "main",
      is_active: true,
    }),
  });
  console.log(JSON.stringify({ ok: true, created: true, store: created?.[0] ?? created }, null, 2));
}

async function provision({ name, email, password }) {
  const pharmacyName = name || "Synapse Test Pharmacy";
  const adminEmail = (email || `pharmacy.test+${Date.now()}@synapseos.tech`).toLowerCase();
  const slug = `pharm-${slugify(pharmacyName)}`;
  const tenantId = crypto.randomUUID();
  // Generated passwords are high-entropy and never shown; the admin uses Forgot password.
  const tempPassword = password || randomBytes(24).toString("base64url");
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const defaultDomain = `https://pharm.synapseos.tech/${slug.replace(/^pharm-/, "")}`;

  const existing = await rest(`profiles?email=eq.${encodeURIComponent(adminEmail)}&select=id&limit=1`);
  if (existing?.length) {
    throw new Error(`Email already registered: ${adminEmail}`);
  }

  await rest("tenants", {
    method: "POST",
    body: JSON.stringify({
      id: tenantId,
      slug,
      name: pharmacyName,
      facility_type: "pharmacy",
      district: "Kampala",
      is_active: true,
      status: "active",
      plan: "starter",
      email: adminEmail,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });

  try {
    await rest("pharmacy_profiles", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        pharmacy_name: pharmacyName,
        district: "Kampala",
        contact_email: adminEmail,
        default_domain: defaultDomain,
        is_network_visible: true,
        migration_status: "ready",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn("pharmacy_profiles insert:", e.message);
  }

  const profileId = crypto.randomUUID();
  await rest("profiles", {
    method: "POST",
    body: JSON.stringify({
      id: profileId,
      email: adminEmail,
      full_name: "Test Pharmacy Admin",
      first_name: "Test",
      last_name: "Admin",
      role: "pharmacy_admin",
      tenant_id: tenantId,
      is_admin: true,
      password_hash: passwordHash,
      must_change_password: false,
      email_verified_at: new Date().toISOString(),
      verification_status: "verified",
    }),
  });

  try {
    await rest("pharmacy_user_settings", {
      method: "POST",
      body: JSON.stringify({
        profile_id: profileId,
        tenant_id: tenantId,
        pharmacy_role: "pharmacy_admin",
        permissions: [],
        is_active: true,
        must_change_password: false,
      }),
    });
  } catch (e) {
    console.warn("pharmacy_user_settings insert:", e.message);
  }

  try {
    await rest("pharmacy_onboarding", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        admin_email: adminEmail,
        admin_name: "Test Pharmacy Admin",
        current_step: 5,
        account_created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn("pharmacy_onboarding insert:", e.message);
  }

  try {
    await rest("pharmacy_stores", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        name: `${pharmacyName} — Main Branch`,
        store_type: "main",
        is_active: true,
      }),
    });
  } catch (e) {
    console.warn("pharmacy_stores insert:", e.message);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenantId,
        slug,
        pharmacyName,
        loginUrl: "https://pharm.synapseos.tech/login",
        defaultDomain,
        adminEmail,
        // Never print credentials (CodeQL js/clear-text-logging #6). An operator-supplied
        // --password is already known to the operator; a generated one is discarded and
        // the admin sets their own via https://pharm.synapseos.tech/forgot-password.
        passwordSource: password ? "provided via --password (not echoed)" : "generated and discarded — use Forgot password",
        note: "Login requires email OTP sent to adminEmail",
      },
      null,
      2
    )
  );
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "list";

try {
  if (cmd === "list") {
    await listPharmacies();
  } else if (cmd === "inspect") {
    const id = args._[1] || args.id;
    if (!id) throw new Error("Usage: inspect <tenant-id>");
    await inspect(id);
  } else if (cmd === "set-otp") {
    const email = args.email || args._[1];
    if (!email) throw new Error("Usage: set-otp --email x [--otp 123456]");
    await setTestOtp(email, args.otp || "123456");
  } else if (cmd === "ensure-store") {
    const id = args._[1] || args.id;
    if (!id) throw new Error("Usage: ensure-store <tenant-id>");
    await ensureStore(id);
  } else if (cmd === "provision") {
    await provision({ name: args.name, email: args.email, password: args.password });
  } else {
    console.error("Usage: node scripts/pharmacy-test-setup.mjs [list|provision] [--email x] [--name x] [--password x]");
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
