export const dynamic = "force-dynamic";

import { requirePlatformPage } from "../../../../lib/platform/auth";
import { safeRows } from "../../_lib/platform-data";
import { getDocumentSettings } from "../_lib/document-settings";
import { DocumentEditorForm } from "../_components/document-editor-form";

type TenantRow = { id?: string; name?: string | null };

const ERRORS: Record<string, string> = {
  facility: "Facility / customer organization is required.",
  customer: "Customer name is required.",
  amount: "Enter a valid amount in UGX (decimals allowed, e.g. 150000.50).",
  save: "Could not save the document. The billing documents table may still be migrating — try again in a minute.",
};

export default async function CreateDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; error?: string; detail?: string }>;
}) {
  await requirePlatformPage("/platform/receipts/new");
  const params = await searchParams;
  const kind = params.kind === "invoice" ? "invoice" : "receipt";
  const errorBase = params.error ? ERRORS[params.error] ?? "Something went wrong." : null;
  const error = errorBase
    ? params.detail
      ? `${errorBase} (${params.detail})`
      : errorBase
    : null;

  const [tenantRows, settings] = await Promise.all([
    safeRows<TenantRow>("tenants", "id, name", { orderBy: "name", ascending: true, limit: 2000 }),
    getDocumentSettings(),
  ]);

  const tenants = tenantRows
    .filter((t): t is TenantRow & { id: string } => Boolean(t.id))
    .map((t) => ({ id: t.id, name: t.name?.trim() || t.id }));

  return (
    <DocumentEditorForm
      mode="create"
      initial={{ kind }}
      error={error}
      tenants={tenants}
      signerName={settings.signerName}
      signerTitle={settings.signerTitle}
      signatureSrc={settings.signatureSrc}
    />
  );
}
