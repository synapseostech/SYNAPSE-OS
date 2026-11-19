export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { requirePlatformPage } from "../../../../../lib/platform/auth";
import { formatDate } from "../../../_lib/platform-data";
import { safeRows } from "../../../_lib/platform-data";
import { DocumentEditorForm } from "../../_components/document-editor-form";
import { getDocumentSettings } from "../../_lib/document-settings";
import { getPlatformBillingDocument } from "../../_lib/documents";

type TenantRow = { id?: string; name?: string | null };

const ERRORS: Record<string, string> = {
  facility: "Facility / customer organization is required.",
  customer: "Customer name is required.",
  amount: "Enter a valid amount in UGX (decimals allowed, e.g. 150000.50).",
  save: "Could not save changes. Try again in a moment.",
};

export default async function EditDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  await requirePlatformPage("/platform/receipts/[id]/edit");
  const { id } = await params;
  const q = await searchParams;

  const [doc, settings, tenantRows] = await Promise.all([
    getPlatformBillingDocument(id),
    getDocumentSettings(),
    safeRows<TenantRow>("tenants", "id, name", { orderBy: "name", ascending: true, limit: 2000 }),
  ]);

  if (!doc) notFound();

  const errorBase = q.error ? ERRORS[q.error] ?? "Something went wrong." : null;
  const error = errorBase ? (q.detail ? `${errorBase} (${q.detail})` : errorBase) : null;

  const tenants = tenantRows
    .filter((t): t is TenantRow & { id: string } => Boolean(t.id))
    .map((t) => ({ id: t.id, name: t.name?.trim() || t.id }));

  const meta = doc.metadata ?? {};

  return (
    <DocumentEditorForm
      mode="edit"
      error={error}
      tenants={tenants}
      signerName={settings.signerName}
      signerTitle={settings.signerTitle}
      signatureSrc={settings.signatureSrc}
      initial={{
        id: doc.id,
        source: doc.source,
        documentNo: doc.document_no,
        kind: doc.kind,
        tenantId: doc.tenant_id,
        facilityName: doc.facility_name,
        customerName: doc.customer_name ?? "",
        customerEmail: doc.customer_email,
        description: doc.description,
        amountUgx: Number(doc.amount_ugx ?? 0),
        dueDate: doc.due_date || doc.period_end,
        method: doc.method,
        paymentRef: (meta.payment_ref as string | undefined) ?? null,
        paymentInstructions: (meta.payment_instructions as string | undefined) ?? null,
        notes: doc.notes,
        issuedAtLabel: formatDate(doc.issued_at) ?? undefined,
      }}
    />
  );
}
