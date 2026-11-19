export const dynamic = "force-dynamic";

import Link from "next/link";
import { Bot, LockKeyhole, Mail, MessageSquare, ServerCog, ShieldCheck, ToggleLeft, Video } from "lucide-react";
import { requirePlatformPage } from "../../../lib/platform/auth";

const settingsGroups = [
  {
    title: "Communications",
    icon: Mail,
    items: [
      ["Resend", "RESEND_API_KEY", Boolean(process.env.RESEND_API_KEY)],
      ["Africa's Talking", "AFRICAS_TALKING_API_KEY", Boolean(process.env.AFRICAS_TALKING_API_KEY)],
      ["Sender ID", "AFRICAS_TALKING_SENDER_ID", Boolean(process.env.AFRICAS_TALKING_SENDER_ID)],
    ],
  },
  {
    title: "AI Configuration",
    icon: Bot,
    items: [
      ["Gemini fallback", "GEMINI_API_KEY", Boolean(process.env.GEMINI_API_KEY)],
      ["OpenRouter (clinical demo)", "OPENROUTER_API_KEY", Boolean(process.env.OPENROUTER_API_KEY)],
      ["DeepSeek fallback", "DEEPSEEK_API_KEY", Boolean(process.env.DEEPSEEK_API_KEY)],
    ],
  },
  {
    title: "Integrations",
    icon: ServerCog,
    items: [
      ["DHIS2 URL", "DHIS2_URL", Boolean(process.env.DHIS2_URL)],
      ["Vercel token", "VERCEL_TOKEN", Boolean(process.env.VERCEL_TOKEN)],
      ["Flutterwave", "FLUTTERWAVE_SECRET_KEY", Boolean(process.env.FLUTTERWAVE_SECRET_KEY)],
    ],
  },
  {
    title: "Video",
    icon: Video,
    items: [
      ["LiveKit URL", "NEXT_PUBLIC_LIVEKIT_URL", Boolean(process.env.NEXT_PUBLIC_LIVEKIT_URL)],
      ["LiveKit key", "LIVEKIT_API_KEY", Boolean(process.env.LIVEKIT_API_KEY)],
      ["LiveKit secret", "LIVEKIT_API_SECRET", Boolean(process.env.LIVEKIT_API_SECRET)],
    ],
  },
];

export default async function PlatformSettingsPage() {
  await requirePlatformPage("/platform/settings");
  const adminEmails = (process.env.ADMIN_EMAILS ?? "").split(",").map((email) => email.trim()).filter(Boolean);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Platform Controls</p>
          <h1 className="mt-2 text-2xl font-bold">System Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Environment readiness, communications, AI, integrations, admin access, and maintenance controls.</p>
        </div>
        <Link href="/platform/system/settings" className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200">
          Legacy settings page
        </Link>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {settingsGroups.map((group) => {
          const Icon = group.icon;
          return (
            <article key={group.title} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
              <div className="mb-4 flex items-center gap-2">
                <Icon className="h-4 w-4 text-[#E8B84B]" />
                <h2 className="text-sm font-semibold">{group.title}</h2>
              </div>
              <div className="space-y-2">
                {group.items.map(([label, key, configured]) => (
                  <div key={String(key)} className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#07070A] px-3 py-2">
                    <div>
                      <p className="text-sm text-slate-200">{label}</p>
                      <p className="text-xs text-slate-600">{key}</p>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs ${configured ? "border-green-500/25 bg-green-500/10 text-green-300" : "border-amber-500/25 bg-amber-500/10 text-amber-300"}`}>
                      {configured ? "configured" : "pending"}
                    </span>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="text-sm font-semibold">Access Control</h2>
          </div>
          <div className="space-y-2">
            {adminEmails.map((email) => (
              <div key={email} className="rounded-lg border border-slate-800 bg-[#07070A] px-3 py-2 text-sm text-slate-300">{email}</div>
            ))}
            {adminEmails.length === 0 ? <p className="text-sm text-slate-500">ADMIN_EMAILS is not configured.</p> : null}
          </div>
        </article>

        <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <div className="mb-3 flex items-center gap-2">
            <LockKeyhole className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="text-sm font-semibold">MFA Requirement</h2>
          </div>
          <p className="text-sm text-slate-300">Platform admin pages require Supabase MFA assurance level aal2.</p>
          <Link href="/platform/mfa" className="mt-4 inline-block rounded-xl bg-[#F97316] px-4 py-2 text-sm font-bold text-[#07070A]">
            Manage authenticator
          </Link>
        </article>

        <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <div className="mb-3 flex items-center gap-2">
            <ToggleLeft className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="text-sm font-semibold">Maintenance Mode</h2>
          </div>
          <p className="text-sm text-slate-300">Maintenance controls are prepared for a `system_settings` backed toggle.</p>
          <button type="button" className="mt-4 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300">
            Configure maintenance
          </button>
        </article>
      </section>

      <section className="rounded-xl border border-[#E8B84B]/25 bg-[#E8B84B]/10 p-4">
        <div className="flex gap-3">
          <MessageSquare className="mt-0.5 h-5 w-5 shrink-0 text-[#E8B84B]" />
          <div>
            <h2 className="text-sm font-semibold text-[#E8B84B]">Production note</h2>
            <p className="mt-1 text-sm text-slate-300">
              Secrets are not displayed here. This page reports whether required environment variables are configured and links the admin to operational controls.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
