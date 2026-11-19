export const dynamic = "force-dynamic";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "../../../lib/supabase/server";
import { requirePlatformAccess, requirePlatformPage } from "../../../lib/platform/auth";
import { formatDate, formatUGX, logPlatformEvent, safeCount, safeRows, formatDateTime } from "../_lib/platform-data";
import { listAllPayments } from "@synapse/auth/billing";

type SubscriptionRow = {
  id?: string;
  tenant_id?: string | null;
  plan?: string | null;
  status?: string | null;
  monthly_amount_ugx?: number | string | null;
  billing_cycle_start?: string | null;
  billing_cycle_end?: string | null;
  last_payment_date?: string | null;
  next_billing_date?: string | null;
};

type TenantRow = {
  id?: string;
  name?: string | null;
  subscription_tier?: string | null;
  status?: string | null;
};

type TenantSubRow = {
  id?: string;
  tenant_id?: string | null;
  status?: string | null;
  current_period_end?: string | null;
  grace_until?: string | null;
  last_payment_at?: string | null;
  subscription_plans?: { slug?: string; name?: string; price_ugx?: number } | null;
};

function paymentStatusClass(status: string | null | undefined) {
  if (status === "successful") return "border-green-500/25 bg-green-500/10 text-green-300";
  if (status === "pending") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  if (status === "failed") return "border-red-500/25 bg-red-500/10 text-red-300";
  return "border-slate-700 bg-slate-800 text-slate-300";
}

function statusClass(status: string | null | undefined) {
  if (status === "active") return "border-green-500/25 bg-green-500/10 text-green-300";
  if (status === "trial" || status === "trialing") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  if (status === "past_due") return "border-orange-500/25 bg-orange-500/10 text-orange-300";
  if (status === "suspended" || status === "cancelled") return "border-red-500/25 bg-red-500/10 text-red-300";
  return "border-slate-700 bg-slate-800 text-slate-300";
}

function nextMonthIsoDate() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
}

async function generateInvoice(formData: FormData) {
  "use server";
  const profile = await requirePlatformAccess("platform.subscriptions.activate");
  const subscriptionId = String(formData.get("subscription_id") ?? "");
  const tenantId = String(formData.get("tenant_id") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  if (!subscriptionId || !tenantId) return;

  try {
    const supabaseAdmin = createServiceClient();
    await (supabaseAdmin as any).from("billing_invoices").insert({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      amount_ugx: amount,
      status: "issued",
      due_date: nextMonthIsoDate(),
      created_by: profile.id,
      created_at: new Date().toISOString(),
    });
  } catch {}

  await logPlatformEvent({
    actorId: profile.id,
    action: "billing.invoice_generated",
    entityType: "facility_subscription",
    entityId: subscriptionId,
    tenantId,
    metadata: { amount_ugx: amount },
  });
  revalidatePath("/platform/billing");
}

async function markSubscriptionPaid(formData: FormData) {
  "use server";
  const profile = await requirePlatformAccess("platform.subscriptions.activate");
  const subscriptionId = String(formData.get("subscription_id") ?? "");
  const tenantId = String(formData.get("tenant_id") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  if (!subscriptionId || !tenantId) return;

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any)
    .from("facility_subscriptions")
    .update({
      status: "active",
      last_payment_date: new Date().toISOString(),
      next_billing_date: nextMonthIsoDate(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId);

  try {
    await (supabaseAdmin as any).from("billing_payments").insert({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      amount_ugx: amount,
      method: "manual_admin",
      status: "paid",
      paid_at: new Date().toISOString(),
      recorded_by: profile.id,
    });
  } catch {}

  await logPlatformEvent({
    actorId: profile.id,
    action: "billing.payment_marked_paid",
    entityType: "facility_subscription",
    entityId: subscriptionId,
    tenantId,
    metadata: { amount_ugx: amount, method: "manual_admin" },
  });
  revalidatePath("/platform/billing");
}

async function changeSubscriptionPlan(formData: FormData) {
  "use server";
  const profile = await requirePlatformAccess("platform.subscription.manage");
  const subscriptionId = String(formData.get("subscription_id") ?? "");
  const tenantId = String(formData.get("tenant_id") ?? "");
  const plan = String(formData.get("plan") ?? "");
  const monthlyAmount = Number(formData.get("monthly_amount_ugx") ?? 0);
  const allowedPlans = new Set(["trial", "starter", "professional", "enterprise"]);
  if (!subscriptionId || !tenantId || !allowedPlans.has(plan)) return;

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any)
    .from("facility_subscriptions")
    .update({ plan, monthly_amount_ugx: monthlyAmount, status: plan === "trial" ? "trial" : "active", updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  await (supabaseAdmin as any).from("tenants").update({ subscription_tier: plan, status: plan === "trial" ? "trial" : "active" }).eq("id", tenantId);

  await logPlatformEvent({
    actorId: profile.id,
    action: "billing.plan_changed",
    entityType: "facility_subscription",
    entityId: subscriptionId,
    tenantId,
    metadata: { plan, monthly_amount_ugx: monthlyAmount },
  });
  revalidatePath("/platform/billing");
}

export default async function PlatformBillingPage() {
  await requirePlatformPage("/platform/billing");

  const [subscriptions, tenants, trialFacilities, tenantSubs, flutterwavePayments] = await Promise.all([
    safeRows<SubscriptionRow>(
      "facility_subscriptions",
      "id, tenant_id, plan, status, monthly_amount_ugx, billing_cycle_start, billing_cycle_end, last_payment_date, next_billing_date",
      { orderBy: "next_billing_date", ascending: true, limit: 100 }
    ),
    safeRows<TenantRow>("tenants", "id, name, subscription_tier, status", { limit: 5000 }),
    safeCount("tenants", [["status", "trial"]]),
    safeRows<TenantSubRow>(
      "tenant_subscriptions",
      "id, tenant_id, status, current_period_end, grace_until, last_payment_at, subscription_plans(slug, name, price_ugx)",
      { orderBy: "current_period_end", ascending: true, limit: 200 }
    ),
    listAllPayments(100),
  ]);

  const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const activeSubscriptions = subscriptions.filter((row) => row.status === "active");
  const mrr = activeSubscriptions.reduce((sum, row) => sum + Number(row.monthly_amount_ugx ?? 0), 0);
  const planCounts = subscriptions.reduce<Record<string, number>>((acc, row) => {
    const key = row.plan ?? tenantMap.get(row.tenant_id ?? "")?.subscription_tier ?? "unassigned";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const fwCollected = flutterwavePayments
    .filter((p) => p.status === "successful")
    .reduce((sum, p) => sum + Number(p.amount_ugx ?? 0), 0);
  const fwPending = flutterwavePayments.filter((p) => p.status === "pending").length;
  const pastDueCount = tenantSubs.filter((s) => s.status === "past_due").length;
  const suspendedCount = tenantSubs.filter((s) => s.status === "suspended").length;

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Revenue Command</p>
        <h1 className="mt-2 text-2xl font-bold">Revenue + Billing</h1>
        <p className="mt-1 text-sm text-slate-400">
          Track subscriptions, Flutterwave mobile-money payments, grace periods, and manual billing actions.
          Webhook URL: <code className="text-xs text-slate-500">/api/billing/webhook/flutterwave</code>
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          ["MRR", formatUGX(mrr)],
          ["Flutterwave collected", formatUGX(fwCollected)],
          ["Past due", pastDueCount.toLocaleString()],
          ["Suspended", suspendedCount.toLocaleString()],
          ["FW pending", fwPending.toLocaleString()],
          ["Active subs", activeSubscriptions.length.toLocaleString()],
        ].map(([label, value]) => (
          <article key={label} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-xl font-bold text-[#F97316]">{value}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <h2 className="text-sm font-semibold">Plan Mix</h2>
          <div className="mt-4 space-y-3">
            {Object.entries(planCounts).length === 0 ? <p className="text-sm text-slate-500">No subscriptions yet.</p> : null}
            {Object.entries(planCounts).map(([plan, count]) => (
              <div key={plan}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="capitalize text-slate-300">{plan}</span>
                  <span className="text-slate-500">{count}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-800">
                  <div className="h-2 rounded-full bg-gradient-to-r from-[#F97316] to-[#E8B84B]" style={{ width: `${Math.min(100, count * 12)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
            <div>
              <h2 className="text-sm font-semibold">Subscriptions</h2>
              <p className="mt-1 text-xs text-slate-500">Invoices, manual payments, plan changes, and outstanding balances.</p>
            </div>
            <div className="flex gap-2">
              <a href="/api/platform/billing/export?type=payments" className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500">
                Export payments CSV
              </a>
              <a href="/api/platform/billing/export?type=invoices" className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500">
                Export invoices CSV
              </a>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Facility</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Monthly</th>
                  <th className="px-4 py-3">Next billing</th>
                  <th className="px-4 py-3">Last payment</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {subscriptions.map((subscription) => {
                  const tenant = tenantMap.get(subscription.tenant_id ?? "");
                  return (
                    <tr key={subscription.id ?? subscription.tenant_id ?? crypto.randomUUID()}>
                      <td className="px-4 py-3 font-medium text-slate-100">{tenant?.name ?? "Unknown facility"}</td>
                      <td className="px-4 py-3 capitalize text-slate-300">{subscription.plan ?? tenant?.subscription_tier ?? "unassigned"}</td>
                      <td className="px-4 py-3 text-slate-300">{formatUGX(Number(subscription.monthly_amount_ugx ?? 0))}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(subscription.next_billing_date)}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(subscription.last_payment_date)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(subscription.status)}`}>
                          {subscription.status ?? "unknown"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <form action={generateInvoice}>
                            <input type="hidden" name="subscription_id" value={subscription.id ?? ""} />
                            <input type="hidden" name="tenant_id" value={subscription.tenant_id ?? ""} />
                            <input type="hidden" name="amount" value={Number(subscription.monthly_amount_ugx ?? 0)} />
                            <button type="submit" className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">Invoice</button>
                          </form>
                          <form action={markSubscriptionPaid}>
                            <input type="hidden" name="subscription_id" value={subscription.id ?? ""} />
                            <input type="hidden" name="tenant_id" value={subscription.tenant_id ?? ""} />
                            <input type="hidden" name="amount" value={Number(subscription.monthly_amount_ugx ?? 0)} />
                            <button type="submit" className="rounded-lg border border-green-500/30 px-2 py-1 text-xs text-green-300">Mark paid</button>
                          </form>
                          <form action={changeSubscriptionPlan} className="flex flex-wrap gap-2">
                            <input type="hidden" name="subscription_id" value={subscription.id ?? ""} />
                            <input type="hidden" name="tenant_id" value={subscription.tenant_id ?? ""} />
                            <select name="plan" defaultValue={subscription.plan ?? tenant?.subscription_tier ?? "starter"} className="rounded-lg border border-slate-700 bg-[#07070A] px-2 py-1 text-xs text-slate-300">
                              <option value="trial">trial</option>
                              <option value="starter">starter</option>
                              <option value="professional">professional</option>
                              <option value="enterprise">enterprise</option>
                            </select>
                            <input
                              name="monthly_amount_ugx"
                              type="number"
                              min="0"
                              step="1000"
                              defaultValue={Number(subscription.monthly_amount_ugx ?? 0)}
                              className="w-24 rounded-lg border border-slate-700 bg-[#07070A] px-2 py-1 text-xs text-slate-300"
                            />
                            <button type="submit" className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">Save</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {subscriptions.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No subscription records yet. Add facility_subscriptions to activate billing automation.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
        <div className="border-b border-slate-800 p-4">
          <h2 className="text-sm font-semibold">Flutterwave payments</h2>
          <p className="mt-1 text-xs text-slate-500">Mobile money and card subscription payments — source of truth is the webhook, not the redirect.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Facility</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Confirmed</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {flutterwavePayments.map((payment) => (
                <tr key={payment.id}>
                  <td className="px-4 py-3 font-medium text-slate-100">{payment.tenant_name ?? tenantMap.get(payment.tenant_id)?.name ?? "Unknown"}</td>
                  <td className="px-4 py-3 font-mono text-slate-300">{formatUGX(Number(payment.amount_ugx ?? 0))}</td>
                  <td className="px-4 py-3 capitalize text-slate-400">{payment.method ?? "flutterwave"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{payment.provider_tx_ref ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDateTime(payment.created_at)}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDateTime(payment.confirmed_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs ${paymentStatusClass(payment.status)}`}>{payment.status}</span>
                  </td>
                </tr>
              ))}
              {flutterwavePayments.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No Flutterwave payments yet. Apply migration and configure webhook in Flutterwave dashboard.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {tenantSubs.length > 0 ? (
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
          <div className="border-b border-slate-800 p-4">
            <h2 className="text-sm font-semibold">Tenant subscriptions (state machine)</h2>
            <p className="mt-1 text-xs text-slate-500">Grace, period end, and suspension status from tenant_subscriptions.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Facility</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Period end</th>
                  <th className="px-4 py-3">Grace until</th>
                  <th className="px-4 py-3">Last payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {tenantSubs.map((sub) => {
                  const tenant = tenantMap.get(sub.tenant_id ?? "");
                  const plan = sub.subscription_plans;
                  return (
                    <tr key={sub.id ?? sub.tenant_id}>
                      <td className="px-4 py-3 font-medium text-slate-100">{tenant?.name ?? "Unknown"}</td>
                      <td className="px-4 py-3 text-slate-300">{plan?.name ?? plan?.slug ?? "—"}</td>
                      <td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(sub.status)}`}>{sub.status}</span></td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(sub.current_period_end)}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(sub.grace_until)}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(sub.last_payment_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Revenue streams overview ── */}
      <section className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <h2 className="text-sm font-semibold">Revenue streams</h2>
        <p className="mt-1 text-xs text-slate-500">
          All active revenue mechanisms for Synapse OS. Expand each stream as the platform scales.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              stream: "Pharmacy subscriptions",
              model: "UGX 250K / 750K / 1.5M per month",
              status: "Live — Flutterwave webhook active",
              note: "Primary revenue. 3 tiers: Starter · Growth · Multi-Branch.",
            },
            {
              stream: "Transaction fee (0.5%)",
              model: "0.5% on POS volume > UGX 3.7M/month",
              status: "Passive — implement monthly cron aggregate",
              note: "Auto-billed at month end. No per-pharmacy setup needed. Requires monthly POS aggregate cron job writing to subscription_payments.",
            },
            {
              stream: "Hospital HMIS subscriptions",
              model: "Custom quote — contact sales",
              status: "Manual invoicing via platform billing",
              note: "Track via facility_subscriptions. Use Mark paid action above.",
            },
            {
              stream: "SMS credits",
              model: "UGX 18,500 per 500 credits (~$5)",
              status: "UI stub — wire to Flutterwave + AT",
              note: "2× markup on Africa's Talking bulk SMS rate. Requires tenants.sms_credits column (migration).",
            },
          ].map(({ stream, model, status, note }) => (
            <div key={stream} className="rounded-lg border border-slate-800 bg-[#0A0A0F] p-4">
              <p className="text-xs font-bold text-[#E8B84B]">{stream}</p>
              <p className="mt-1 font-mono text-xs text-slate-300">{model}</p>
              <p className="mt-2 text-xs text-slate-500">{status}</p>
              <p className="mt-1 text-xs text-slate-600">{note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Hospital HMIS pricing reference ── */}
      <section className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <h2 className="text-sm font-semibold">Hospital HMIS pricing reference</h2>
        <p className="mt-1 text-xs text-slate-500 mb-4">
          Reference tiers for sales quoting. Actual invoices are created manually via the Subscriptions table above.
          Contact{" "}
          <a href="mailto:sales@synapseos.tech" className="text-[#E8B84B] hover:underline">
            sales@synapseos.tech
          </a>{" "}
          to onboard a hospital.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              name: "Clinic / Dispensary",
              monthly: "UGX 500,000",
              usdRef: "~$135",
              includes: ["Up to 20 beds", "OPD + pharmacy", "Basic billing", "2 admin accounts"],
            },
            {
              name: "District Hospital",
              monthly: "UGX 1,500,000",
              usdRef: "~$405",
              includes: ["Up to 200 beds", "Full HMIS modules", "Lab + radiology", "Insurance billing", "10 accounts"],
            },
            {
              name: "Referral / Regional",
              monthly: "Custom",
              usdRef: "Contact sales",
              includes: ["Unlimited beds", "All modules", "API access", "Dedicated support", "SLA guarantee"],
            },
          ].map(({ name, monthly, usdRef, includes }) => (
            <div key={name} className="rounded-lg border border-slate-700 bg-[#0A0A0F] p-4">
              <p className="font-semibold text-sm">{name}</p>
              <p className="mt-1 font-mono text-lg font-bold text-[#F97316]">{monthly}</p>
              <p className="text-xs text-slate-500">{usdRef} per month</p>
              <ul className="mt-3 space-y-1">
                {includes.map((i) => (
                  <li key={i} className="text-xs text-slate-400">
                    · {i}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
