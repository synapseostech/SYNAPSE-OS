export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformPage } from "../../../../lib/platform/auth";
import { formatDate } from "../../_lib/platform-data";
import { PlatformReceiptDocument } from "../../_components/ReceiptDocument";
import {
  DEFAULT_SIGNATURE_SRC,
  getDocumentSettings,
} from "../_lib/document-settings";
import { formatMoneyUGX, getPlatformBillingDocument } from "../_lib/documents";
import { amountInWordsUGX } from "../_lib/money";
import { DeleteDocumentButton } from "./delete-button";
import { PrintReceiptButton } from "./print-button";

function kampalaLabel(iso: string | null | undefined) {
  if (!iso) return null;
  return formatDate(iso);
}

export default async function PlatformReceiptDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requirePlatformPage("/platform/receipts/[id]");
  const { id } = await params;
  const query = await searchParams;
  const [doc, settings] = await Promise.all([
    getPlatformBillingDocument(id),
    getDocumentSettings(),
  ]);
  if (!doc) notFound();

  const kind = doc.kind;
  const issuedAtLabel = kampalaLabel(doc.issued_at) ?? "—";
  const metaSig = doc.metadata?.signature_data_url as string | undefined;
  const signatureSrc = metaSig || settings.signatureSrc || DEFAULT_SIGNATURE_SRC;
  const signerName = (doc.metadata?.signer_name as string | undefined) ?? settings.signerName;
  const signerTitle = (doc.metadata?.signer_title as string | undefined) ?? settings.signerTitle;
  const paymentRef = (doc.metadata?.payment_ref as string | undefined) ?? null;
  const paymentInstructions =
    (doc.metadata?.payment_instructions as string | undefined) ?? null;

  const periodLabel =
    doc.period_start && doc.period_end
      ? `${kampalaLabel(doc.period_start)} – ${kampalaLabel(doc.period_end)}`
      : null;

  const methodLabel =
    kind === "trial"
      ? "Free trial registration"
      : kind === "invoice"
        ? doc.method || "Pay by MTN MoMo, Airtel Money, bank transfer, or card"
        : doc.method ?? "Flutterwave / Mobile money";

  const amountNum = Number(doc.amount_ugx ?? 0);
  const amountLabel =
    kind === "trial" ? "UGX 0 (free trial)" : formatMoneyUGX(amountNum);

  const duplicateKind = kind === "invoice" ? "invoice" : "receipt";

  return (
    <div className="space-y-6">
      {query.ok === "updated" ? (
        <p className="rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300 print:hidden">
          Document updated. Print or save PDF when you are ready.
        </p>
      ) : null}
      {query.error === "delete" ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 print:hidden">
          Could not delete this document. Try again.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href="/platform/receipts" className="text-xs font-semibold text-slate-400 hover:text-slate-200">
            ← All documents
          </Link>
          <h1 className="mt-2 font-display text-2xl font-bold">
            {kind === "invoice" ? "Invoice" : "Receipt"} {doc.document_no}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Printable official document — signed by {signerName}, {signerTitle}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/platform/receipts/${id}/edit`}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-slate-500"
          >
            Edit
          </Link>
          <Link
            href={`/platform/receipts/new?kind=${duplicateKind}`}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-slate-500"
          >
            New {duplicateKind}
          </Link>
          <PrintReceiptButton />
          <DeleteDocumentButton id={doc.id} source={doc.source} documentNo={doc.document_no} />
        </div>
      </div>

      <PlatformReceiptDocument
        receipt={{
          receiptNo: doc.document_no,
          kind,
          facilityName: doc.facility_name,
          planName: doc.description ?? (kind === "invoice" ? "Invoice" : "Receipt"),
          amountLabel,
          amountWords: kind === "trial" ? null : amountInWordsUGX(amountNum),
          customerName: doc.customer_name,
          customerEmail: doc.customer_email,
          periodLabel,
          methodLabel,
          paymentRef,
          paymentInstructions:
            kind === "invoice"
              ? paymentInstructions ||
                "Pay via MTN MoMo, Airtel Money, bank transfer, or card. Include the invoice number as the payment reference."
              : null,
          notes: doc.notes,
          issuedAtLabel,
          dueDateLabel: doc.due_date ? formatDate(doc.due_date) : kampalaLabel(doc.period_end),
          signatureSrc,
          signerName,
          signerTitle,
          signedAtLabel: issuedAtLabel,
        }}
      />
    </div>
  );
}
