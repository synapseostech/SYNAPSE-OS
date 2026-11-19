export const dynamic = "force-dynamic";

import Link from "next/link";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { formatDateTime } from "../_lib/platform-data";
import { clearAuthorizedSignature, uploadAuthorizedSignature } from "./actions";
import { DeleteDocumentLink } from "./_components/delete-document-link";
import { getDocumentSettings } from "./_lib/document-settings";
import { formatMoneyUGX, listPlatformBillingDocuments } from "./_lib/documents";

function kindClass(kind: string) {
  if (kind === "trial") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  if (kind === "invoice") return "border-sky-500/25 bg-sky-500/10 text-sky-300";
  if (kind === "receipt") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  return "border-green-500/25 bg-green-500/10 text-green-300";
}

function kindLabel(kind: string) {
  if (kind === "trial") return "Free trial";
  if (kind === "invoice") return "Invoice";
  if (kind === "receipt") return "Receipt";
  return "Payment";
}

const FLASH: Record<string, string> = {
  signature: "Signer details saved. New receipts and invoices will use this signature.",
  signature_cleared: "Reverted to the bundled CEO signature.",
  signature_required: "Choose a signature image to upload.",
  signature_type: "Use PNG, JPG, WebP, or SVG.",
  signature_too_large: "Signature file is too large (max ~900KB).",
  signature_save: "Could not save the signature. Check the database migration is applied.",
  deleted: "Document deleted.",
  delete: "Could not delete the document.",
};

type FilterKind = "all" | "receipt" | "invoice" | "payment" | "trial";

export default async function PlatformReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; kind?: string; q?: string }>;
}) {
  await requirePlatformPage("/platform/receipts");
  const params = await searchParams;
  const filter: FilterKind =
    params.kind === "receipt" ||
    params.kind === "invoice" ||
    params.kind === "payment" ||
    params.kind === "trial"
      ? params.kind
      : "all";
  const q = (params.q ?? "").trim().toLowerCase();

  const [docs, settings] = await Promise.all([
    listPlatformBillingDocuments(250),
    getDocumentSettings(),
  ]);

  const flashOk = params.ok ? FLASH[params.ok] : null;
  const flashErr = params.error ? FLASH[params.error] : null;

  const paid = docs.filter((row) => row.kind === "payment" || row.kind === "receipt");
  const invoicesOnly = docs.filter((row) => row.kind === "invoice");
  const trials = docs.filter((row) => row.kind === "trial");
  const collected = paid.reduce((sum, row) => sum + Number(row.amount_ugx ?? 0), 0);

  const filtered = docs.filter((doc) => {
    if (filter === "receipt") {
      if (doc.kind !== "receipt" && doc.kind !== "payment") return false;
    } else if (filter !== "all" && doc.kind !== filter) {
      return false;
    }
    if (!q) return true;
    const hay = [
      doc.document_no,
      doc.facility_name,
      doc.customer_name,
      doc.customer_email,
      doc.description,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const filters: { key: FilterKind; label: string; href: string }[] = [
    { key: "all", label: "All", href: "/platform/receipts" },
    { key: "receipt", label: "Receipts", href: "/platform/receipts?kind=receipt" },
    { key: "invoice", label: "Invoices", href: "/platform/receipts?kind=invoice" },
    { key: "payment", label: "Payments", href: "/platform/receipts?kind=payment" },
    { key: "trial", label: "Trials", href: "/platform/receipts?kind=trial" },
  ];

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Money</p>
          <h1 className="mt-2 font-display text-2xl font-bold">Receipts & invoices</h1>
          <p className="mt-1 text-sm text-slate-400">
            Create and print official documents signed by Ebrine Tushabe — CEO, Synapse OS. Auto
            payment and trial receipts also appear here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/platform/receipts/new?kind=receipt"
            className="rounded-xl bg-gradient-to-r from-[#F97316] to-[#E8B84B] px-4 py-2 text-sm font-bold text-[#07070A]"
          >
            New receipt
          </Link>
          <Link
            href="/platform/receipts/new?kind=invoice"
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-slate-500"
          >
            New invoice
          </Link>
        </div>
      </section>

      {flashOk ? (
        <p className="rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
          {flashOk}
        </p>
      ) : null}
      {flashErr ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {flashErr}
        </p>
      ) : null}

      <section id="signature" className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Authorized signature</h2>
            <p className="mt-1 text-xs text-slate-500">
              Default signatory: <span className="text-slate-300">Ebrine Tushabe — CEO, Synapse OS</span>.
              Save name/title anytime — image upload is optional. Date under the signature is filled
              automatically on issue.
            </p>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={settings.signatureSrc}
            alt="Authorized signature"
            className="h-16 w-auto max-w-[240px] rounded-lg border border-slate-700 bg-white px-3 py-2 object-contain"
          />
        </div>

        <form action={uploadAuthorizedSignature} className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Signer name</span>
            <input
              name="signer_name"
              defaultValue={settings.signerName}
              className="w-full rounded-xl border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-200"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Title</span>
            <input
              name="signer_title"
              defaultValue={settings.signerTitle}
              className="w-full rounded-xl border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-200"
            />
          </label>
          <label className="block space-y-1.5 md:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Replace signature image (optional)
            </span>
            <input
              name="signature"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="w-full rounded-xl border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#F97316]/15 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-[#F97316]"
            />
          </label>
          <div className="flex flex-wrap gap-2 md:col-span-1">
            <button
              type="submit"
              className="rounded-xl border border-[#E8B84B]/40 bg-[#E8B84B]/10 px-4 py-2 text-sm font-semibold text-[#E8B84B]"
            >
              Save
            </button>
          </div>
        </form>
        {settings.signatureDataUrl ? (
          <form action={clearAuthorizedSignature} className="mt-3">
            <button type="submit" className="text-xs text-slate-500 underline hover:text-slate-300">
              Revert to bundled CEO signature
            </button>
          </form>
        ) : null}
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "All documents", value: docs.length.toLocaleString(), href: "/platform/receipts" },
          {
            label: "Collected (receipts)",
            value: formatMoneyUGX(collected),
            href: "/platform/receipts?kind=receipt",
          },
          {
            label: "Invoices",
            value: invoicesOnly.length.toLocaleString(),
            href: "/platform/receipts?kind=invoice",
          },
          {
            label: "Trial receipts",
            value: trials.length.toLocaleString(),
            href: "/platform/receipts?kind=trial",
          },
        ].map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="rounded-xl border border-slate-800 bg-[#111117] p-4 transition hover:border-slate-600"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-2 text-xl font-bold text-[#F97316]">{card.value}</p>
          </Link>
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
          <div>
            <h2 className="text-sm font-semibold">Ledger</h2>
            <p className="mt-1 text-xs text-slate-500">
              Open any row for a printable document with logo, CEO signature, and auto date.
            </p>
          </div>
          <Link
            href="/platform/billing"
            className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500"
          >
            Revenue & Billing
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
          {filters.map((f) => (
            <Link
              key={f.key}
              href={q ? `${f.href}${f.href.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}` : f.href}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                filter === f.key
                  ? "border border-[#F97316]/40 bg-[#F97316]/10 text-[#F97316]"
                  : "border border-slate-700 text-slate-400 hover:text-slate-200"
              }`}
            >
              {f.label}
            </Link>
          ))}
          <form className="ml-auto flex min-w-[200px] flex-1 max-w-sm gap-2" method="get">
            {filter !== "all" ? <input type="hidden" name="kind" value={filter} /> : null}
            <input
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search number, facility, customer…"
              className="w-full rounded-xl border border-slate-700 bg-[#07070A] px-3 py-1.5 text-xs text-slate-200"
            />
            <button
              type="submit"
              className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300"
            >
              Search
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Number</th>
                <th className="px-4 py-3">Facility</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Issued</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((doc) => (
                <tr key={`${doc.source}-${doc.id}`}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-200">{doc.document_no}</td>
                  <td className="px-4 py-3 font-medium text-slate-100">{doc.facility_name}</td>
                  <td className="px-4 py-3 text-slate-300">{doc.customer_name ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-300">{doc.description ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-300">
                    {doc.kind === "trial" ? "UGX 0" : formatMoneyUGX(Number(doc.amount_ugx ?? 0))}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDateTime(doc.issued_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs ${kindClass(doc.kind)}`}>
                      {kindLabel(doc.kind)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Link
                        href={`/platform/receipts/${doc.id}`}
                        className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-[#E8B84B] hover:border-[#E8B84B]/40"
                      >
                        View
                      </Link>
                      <Link
                        href={`/platform/receipts/${doc.id}/edit`}
                        className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500"
                      >
                        Edit
                      </Link>
                      <DeleteDocumentLink
                        id={doc.id}
                        source={doc.source}
                        documentNo={doc.document_no}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    {docs.length === 0
                      ? "No documents yet. Create a receipt or invoice to get started."
                      : "No documents match this filter."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
