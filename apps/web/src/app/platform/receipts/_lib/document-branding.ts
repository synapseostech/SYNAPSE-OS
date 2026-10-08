/** Bundled CEO signature — used when DB has no custom upload yet. */
export const DEFAULT_SIGNATURE_SRC = "/assets/signatures/authorized-signature.png";
export const DEFAULT_SIGNER_NAME = "Ebrine Tushabe";
export const DEFAULT_SIGNER_TITLE = "CEO, Synapse OS";

/**
 * Issuer postal address shown on receipts/invoices. Config only
 * (NEXT_PUBLIC_ORGANIZATION_POSTAL_ADDRESS); never hardcode a personal or
 * residential address. When unset, the address line is omitted.
 */
export const ORGANIZATION_POSTAL_ADDRESS: string | null =
  process.env.NEXT_PUBLIC_ORGANIZATION_POSTAL_ADDRESS?.trim().slice(0, 300) || null
