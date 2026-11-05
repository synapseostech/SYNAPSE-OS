/**
 * Shared pharmacy receipt-domain service — pure, dependency-free, client-safe.
 *
 * One receipt model used by the pharmacy web portal, the Expo pharmacy app, PDF
 * generation and thermal-printer output. Receipt data is an **immutable snapshot**
 * of sale-time information: editing a product later must never change a historical
 * receipt, so `buildReceiptSnapshot` deep-freezes its output and callers must
 * persist/pass the snapshot, not re-derive it from mutable catalogue rows.
 *
 * Fiscal integrity: a document is only labelled fiscal when EFRIS has actually
 * accepted it. Otherwise it is clearly a POS / non-fiscal receipt.
 */

// ---------------------------------------------------------------------------
// Input & snapshot types
// ---------------------------------------------------------------------------

export interface ReceiptPharmacy {
  legalName: string;
  tradingName?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  tin?: string | null;
  ndaLicenseNumber?: string | null;
  supervisingPharmacist?: string | null;
  pharmacistRegNumber?: string | null;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  currency?: string | null; // ISO-ish label, e.g. "UGX"
}

export interface ReceiptLineInput {
  name: string;
  genericName?: string | null;
  strength?: string | null;
  dosageForm?: string | null;
  quantity: number;
  unit?: string | null;
  packageName?: string | null;
  unitPrice: number;
  listPrice?: number | null;
  discount?: number | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  manufacturer?: string | null;
  prescriptionRef?: string | null;
}

/**
 * Composition of the sale's tax, taken from the figures persisted on its lines.
 * Absent for sales completed before line-level tax existed — those receipts keep
 * the header "Tax/VAT" row alone rather than having a breakdown invented for them.
 */
export interface ReceiptTaxBreakdown {
  source: "vat" | "legacy" | "none";
  /** Percentage applied to `taxableAmount`; null when the source is not VAT. */
  ratePct?: number | null;
  taxableAmount?: number | null;
  exemptAmount?: number | null;
  zeroRatedAmount?: number | null;
}

export type EfrisStatus = "accepted" | "pending" | "rejected" | "none";

export interface ReceiptEfris {
  status?: EfrisStatus | null;
  fiscalDocumentNumber?: string | null;
  verificationCode?: string | null;
  qr?: string | null; // EFRIS QR payload/URL
}

export type SaleStatus = "completed" | "voided" | "refunded" | "partially_refunded";

export interface ReceiptSaleInput {
  saleId: string;
  receiptNumber: string;
  createdAt: string; // ISO timestamp (UTC)
  branch?: string | null;
  terminal?: string | null;
  cashier?: string | null;
  patientName?: string | null;
  synapseId?: string | null; // included only when consent permits (caller decides)
  status?: SaleStatus | null;
  paymentMethod: string;
  paymentRef?: string | null;
  amountReceived?: number | null;
  change?: number | null;
  subtotal: number;
  discountTotal?: number | null;
  taxAmount?: number | null;
  tax?: ReceiptTaxBreakdown | null;
  totalAmount: number;
  lines: ReceiptLineInput[];
  efris?: ReceiptEfris | null;
  verificationUrl?: string | null; // Synapse verification QR/URL
}

export interface ReceiptLine {
  name: string;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
  quantity: number;
  unit: string | null;
  packageName: string | null;
  unitPrice: number;
  listPrice: number | null;
  discount: number;
  lineTotal: number;
  batchNumber: string | null;
  expiryDate: string | null;
  manufacturer: string | null;
  prescriptionRef: string | null;
}

export type ReceiptDocumentLabel =
  | "FISCAL RECEIPT"
  | "POS RECEIPT (NON-FISCAL)";

export interface ReceiptSnapshot {
  readonly version: 1;
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly documentLabel: ReceiptDocumentLabel;
  readonly isFiscal: boolean;
  readonly status: SaleStatus;
  readonly isReprint: boolean;
  readonly generatedAt: string; // ISO (UTC) when the snapshot was produced
  readonly dateTimeKampala: string; // human, Africa/Kampala
  readonly pharmacy: ReceiptPharmacy;
  readonly branch: string | null;
  readonly terminal: string | null;
  readonly cashier: string | null;
  readonly patientName: string | null;
  readonly synapseId: string | null;
  readonly currency: string;
  readonly lines: ReadonlyArray<ReceiptLine>;
  readonly subtotal: number;
  readonly discountTotal: number;
  readonly taxAmount: number;
  readonly tax: {
    readonly source: "vat" | "legacy" | "none";
    readonly ratePct: number | null;
    readonly taxableAmount: number;
    readonly exemptAmount: number;
    readonly zeroRatedAmount: number;
  } | null;
  readonly totalAmount: number;
  readonly payment: {
    readonly method: string;
    readonly reference: string | null;
    readonly amountReceived: number | null;
    readonly change: number | null;
  };
  readonly fiscal: {
    readonly status: EfrisStatus;
    readonly documentNumber: string | null;
    readonly verificationCode: string | null;
    readonly qr: string | null;
  };
  readonly verificationUrl: string | null;
  readonly footerNote: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : 0;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Human date-time in Africa/Kampala, e.g. "2026-08-06 15:42 EAT". */
export function kampalaDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} EAT`;
}

/** EFRIS acceptance is the ONLY thing that makes a receipt fiscal. */
export function isFiscalReceipt(efris: ReceiptEfris | null | undefined): boolean {
  return Boolean(
    efris &&
      efris.status === "accepted" &&
      str(efris.fiscalDocumentNumber),
  );
}

function normaliseLine(l: ReceiptLineInput): ReceiptLine {
  const quantity = Math.max(0, num(l.quantity));
  const unitPrice = num(l.unitPrice);
  const discount = Math.max(0, num(l.discount));
  const lineTotal = Math.max(0, quantity * unitPrice - discount);
  return {
    name: String(l.name ?? "").trim() || "Item",
    genericName: str(l.genericName),
    strength: str(l.strength),
    dosageForm: str(l.dosageForm),
    quantity,
    unit: str(l.unit),
    packageName: str(l.packageName),
    unitPrice,
    listPrice: l.listPrice == null ? null : num(l.listPrice),
    discount,
    lineTotal,
    batchNumber: str(l.batchNumber),
    expiryDate: str(l.expiryDate),
    manufacturer: str(l.manufacturer),
    prescriptionRef: str(l.prescriptionRef),
  };
}

// ---------------------------------------------------------------------------
// Snapshot builder (immutable)
// ---------------------------------------------------------------------------

/**
 * Build an immutable receipt snapshot from sale-time data. The result is deep-frozen;
 * persist it (or the JSON) so later product edits never alter a historical receipt.
 */
export function buildReceiptSnapshot(
  input: {
    pharmacy: ReceiptPharmacy;
    sale: ReceiptSaleInput;
    isReprint?: boolean;
    now?: string;
  },
): ReceiptSnapshot {
  const { pharmacy, sale } = input;
  const fiscal = sale.efris ?? { status: "none" as EfrisStatus };
  const isFiscal = isFiscalReceipt(fiscal);
  const status: SaleStatus = sale.status ?? "completed";
  const currency = str(pharmacy.currency) ?? "UGX";

  const lines = sale.lines.map(normaliseLine);

  const taxInput = sale.tax;
  const tax: ReceiptSnapshot["tax"] = taxInput
    ? Object.freeze({
        source: taxInput.source,
        ratePct: taxInput.ratePct == null ? null : num(taxInput.ratePct),
        taxableAmount: num(taxInput.taxableAmount),
        exemptAmount: num(taxInput.exemptAmount),
        zeroRatedAmount: num(taxInput.zeroRatedAmount),
      })
    : null;

  const snapshot: ReceiptSnapshot = {
    version: 1,
    saleId: sale.saleId,
    receiptNumber: sale.receiptNumber,
    documentLabel: isFiscal ? "FISCAL RECEIPT" : "POS RECEIPT (NON-FISCAL)",
    isFiscal,
    status,
    isReprint: Boolean(input.isReprint),
    generatedAt: input.now ?? new Date().toISOString(),
    dateTimeKampala: kampalaDateTime(sale.createdAt),
    pharmacy: Object.freeze({
      legalName: String(pharmacy.legalName ?? "").trim() || "Pharmacy",
      tradingName: str(pharmacy.tradingName),
      logoUrl: str(pharmacy.logoUrl),
      address: str(pharmacy.address),
      phone: str(pharmacy.phone),
      email: str(pharmacy.email),
      tin: str(pharmacy.tin),
      ndaLicenseNumber: str(pharmacy.ndaLicenseNumber),
      supervisingPharmacist: str(pharmacy.supervisingPharmacist),
      pharmacistRegNumber: str(pharmacy.pharmacistRegNumber),
      receiptHeader: str(pharmacy.receiptHeader),
      receiptFooter: str(pharmacy.receiptFooter),
      currency,
    }),
    branch: str(sale.branch),
    terminal: str(sale.terminal),
    cashier: str(sale.cashier),
    patientName: str(sale.patientName),
    synapseId: str(sale.synapseId),
    currency,
    lines: Object.freeze(lines.map((l) => Object.freeze(l))),
    subtotal: num(sale.subtotal),
    discountTotal: num(sale.discountTotal),
    taxAmount: num(sale.taxAmount),
    tax,
    totalAmount: num(sale.totalAmount),
    payment: Object.freeze({
      method: String(sale.paymentMethod ?? "").trim() || "CASH",
      reference: str(sale.paymentRef),
      amountReceived: sale.amountReceived == null ? null : num(sale.amountReceived),
      change: sale.change == null ? null : num(sale.change),
    }),
    fiscal: Object.freeze({
      status: (fiscal.status ?? "none") as EfrisStatus,
      documentNumber: str(fiscal.fiscalDocumentNumber),
      verificationCode: str(fiscal.verificationCode),
      qr: str(fiscal.qr),
    }),
    verificationUrl: str(sale.verificationUrl),
    footerNote: str(pharmacy.receiptFooter),
  };

  return Object.freeze(snapshot);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** "18" for a whole rate, "18.5" otherwise — never "18.0000". */
export function formatTaxRate(ratePct: number): string {
  const n = num(ratePct);
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatMoney(amount: number, currency: string): string {
  const n = num(amount);
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${currency} ${s}`;
}

/** Plain-text receipt (thermal-friendly), default 42 columns. */
export function renderReceiptText(snapshot: ReceiptSnapshot, width = 42): string {
  const c = snapshot.currency;
  const rule = "-".repeat(width);
  const center = (s: string) => {
    if (s.length >= width) return s.slice(0, width);
    const pad = Math.floor((width - s.length) / 2);
    return " ".repeat(pad) + s;
  };
  const kv = (k: string, v: string) => {
    const space = Math.max(1, width - k.length - v.length);
    return k + " ".repeat(space) + v;
  };

  const out: string[] = [];
  const p = snapshot.pharmacy;
  out.push(center(p.tradingName || p.legalName));
  if (p.tradingName && p.legalName !== p.tradingName) out.push(center(p.legalName));
  if (p.address) out.push(center(p.address));
  if (p.phone) out.push(center(p.phone));
  if (p.email) out.push(center(p.email));
  if (p.tin) out.push(center(`TIN: ${p.tin}`));
  if (p.ndaLicenseNumber) out.push(center(`NDA: ${p.ndaLicenseNumber}`));
  if (p.receiptHeader) out.push(center(p.receiptHeader));
  out.push(rule);
  out.push(center(snapshot.documentLabel));
  if (snapshot.isReprint) out.push(center("*** REPRINT ***"));
  if (snapshot.status !== "completed") out.push(center(`*** ${snapshot.status.toUpperCase()} ***`));
  out.push(rule);
  out.push(kv("Receipt:", snapshot.receiptNumber));
  out.push(kv("Date:", snapshot.dateTimeKampala));
  if (snapshot.branch) out.push(kv("Branch:", snapshot.branch));
  if (snapshot.terminal) out.push(kv("Terminal:", snapshot.terminal));
  if (snapshot.cashier) out.push(kv("Served by:", snapshot.cashier));
  if (snapshot.patientName) out.push(kv("Customer:", snapshot.patientName));
  out.push(rule);

  for (const l of snapshot.lines) {
    const title = [l.name, l.strength, l.dosageForm].filter(Boolean).join(" ");
    out.push(title);
    if (l.genericName) out.push(`  (${l.genericName})`);
    const qtyLine = `  ${l.quantity} ${l.packageName || l.unit || "unit"} x ${formatMoney(l.unitPrice, c)}`;
    out.push(kv(qtyLine, formatMoney(l.lineTotal, c)));
    if (l.discount > 0) out.push(`  Discount: -${formatMoney(l.discount, c)}`);
    const batch = [l.batchNumber ? `Batch ${l.batchNumber}` : null, l.expiryDate ? `Exp ${l.expiryDate}` : null]
      .filter(Boolean)
      .join("  ");
    if (batch) out.push(`  ${batch}`);
    if (l.manufacturer) out.push(`  Mfr: ${l.manufacturer}`);
    if (l.prescriptionRef) out.push(`  Rx: ${l.prescriptionRef}`);
  }
  out.push(rule);
  out.push(kv("Subtotal:", formatMoney(snapshot.subtotal, c)));
  if (snapshot.discountTotal > 0) out.push(kv("Discount:", `-${formatMoney(snapshot.discountTotal, c)}`));
  if (snapshot.tax && snapshot.tax.source === "vat") {
    const suffix = snapshot.tax.ratePct == null ? "" : ` (${formatTaxRate(snapshot.tax.ratePct)}%)`;
    if (snapshot.tax.taxableAmount > 0) out.push(kv(`Taxable${suffix}:`, formatMoney(snapshot.tax.taxableAmount, c)));
    if (snapshot.taxAmount > 0) out.push(kv(`VAT${suffix}:`, formatMoney(snapshot.taxAmount, c)));
    if (snapshot.tax.zeroRatedAmount > 0) out.push(kv("Zero-rated:", formatMoney(snapshot.tax.zeroRatedAmount, c)));
    if (snapshot.tax.exemptAmount > 0) out.push(kv("Exempt:", formatMoney(snapshot.tax.exemptAmount, c)));
  } else if (snapshot.taxAmount > 0) {
    out.push(kv("Tax/VAT:", formatMoney(snapshot.taxAmount, c)));
  }
  out.push(kv("TOTAL:", formatMoney(snapshot.totalAmount, c)));
  out.push(kv("Payment:", snapshot.payment.method));
  if (snapshot.payment.reference) out.push(kv("Ref:", snapshot.payment.reference));
  if (snapshot.payment.amountReceived != null) out.push(kv("Received:", formatMoney(snapshot.payment.amountReceived, c)));
  if (snapshot.payment.change != null) out.push(kv("Change:", formatMoney(snapshot.payment.change, c)));
  out.push(rule);
  if (snapshot.isFiscal) {
    out.push(center("EFRIS FISCAL DOCUMENT"));
    if (snapshot.fiscal.documentNumber) out.push(kv("Fiscal No:", snapshot.fiscal.documentNumber));
    if (snapshot.fiscal.verificationCode) out.push(kv("Verify:", snapshot.fiscal.verificationCode));
  } else {
    out.push(center("Not an EFRIS fiscal receipt"));
  }
  if (p.supervisingPharmacist) out.push(center(`Pharmacist: ${p.supervisingPharmacist}`));
  if (p.pharmacistRegNumber) out.push(center(`Reg: ${p.pharmacistRegNumber}`));
  if (snapshot.footerNote) out.push(center(snapshot.footerNote));
  if (snapshot.verificationUrl) out.push(center(`Verify: ${snapshot.verificationUrl}`));
  return out.join("\n");
}

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string),
  );
}

/** HTML receipt for PDF generation (expo-print) or web print. Self-contained, print-optimised. */
export function renderReceiptHtml(
  snapshot: ReceiptSnapshot,
  opts?: { paperWidth?: "58" | "80" | "a4"; fontScale?: number },
): string {
  const c = snapshot.currency;
  const p = snapshot.pharmacy;
  const paper = opts?.paperWidth ?? "80";
  const scale = opts?.fontScale && opts.fontScale > 0 ? opts.fontScale : 1;
  const money = (n: number) => esc(formatMoney(n, c));
  const rows = snapshot.lines
    .map((l) => {
      const title = [l.name, l.strength, l.dosageForm].filter(Boolean).join(" ");
      const sub = [
        l.genericName ? `(${l.genericName})` : null,
        l.batchNumber ? `Batch ${l.batchNumber}` : null,
        l.expiryDate ? `Exp ${l.expiryDate}` : null,
        l.manufacturer ? `Mfr ${l.manufacturer}` : null,
        l.prescriptionRef ? `Rx ${l.prescriptionRef}` : null,
      ]
        .filter(Boolean)
        .map((x) => esc(x as string))
        .join(" · ");
      return `<tr><td class="l">${esc(title)}${sub ? `<div class="sub">${sub}</div>` : ""}</td>
        <td class="c">${esc(String(l.quantity))} ${esc(l.packageName || l.unit || "unit")}</td>
        <td class="r">${money(l.unitPrice)}</td>
        <td class="r">${money(l.lineTotal)}</td></tr>`;
    })
    .join("");

  const watermark = snapshot.isReprint
    ? `<div class="wm">REPRINT</div>`
    : snapshot.status !== "completed"
      ? `<div class="wm">${esc(snapshot.status.toUpperCase())}</div>`
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  * { box-sizing: border-box; }
  @page { margin: 6mm; }
  /* Tahoma is the pharmacy default. The stack falls through to faces that ship
     with Windows, macOS, Android and Linux so a receipt never waits on a web
     font — printing has to work when the till is offline. */
  :root { --receipt-font: Tahoma, Verdana, "Segoe UI", "DejaVu Sans", "Noto Sans", Arial, sans-serif; }
  body {
    font-family: var(--receipt-font);
    color:#0b0b0d;
    margin:0;
    padding:12px;
    font-size: ${Math.round(12 * scale)}px;
    line-height: 1.35;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt { max-width: var(--receipt-width, 360px); margin: 0 auto; position: relative; }
  .receipt.paper-58 { --receipt-width: 220px; }
  .receipt.paper-80 { --receipt-width: 300px; }
  .receipt.paper-a4 { --receipt-width: 640px; }
  .center { text-align:center; }
  .muted { color:#555; font-size:0.92em; }
  h1 {
    font-size:1.35em;
    margin:0;
    letter-spacing: 0.02em;
    font-weight: 700;
  }
  .label { font-weight:700; letter-spacing:1px; margin:8px 0; }
  .nonfiscal { color:#b45309; }
  table { width:100%; border-collapse:collapse; font-size:1em; }
  td { padding:4px 0; vertical-align:top; }
  td.c { text-align:center; white-space:nowrap; padding-left:6px; }
  td.r { text-align:right; white-space:nowrap; padding-left:6px; font-variant-numeric: tabular-nums; }
  .sub { color:#666; font-size:0.85em; }
  hr { border:none; border-top:1px dashed #999; margin:8px 0; }
  .totals td { font-size:1.05em; }
  .totals .tot { font-weight:700; font-size:1.2em; }
  .wm {
    position:absolute; inset:20% 0 auto; text-align:center;
    font-size:2.4em; color:rgba(180,83,9,0.18); font-weight:700;
    transform: rotate(-18deg); pointer-events:none;
  }
  .foot { margin-top:10px; font-size:0.92em; }
  @media print {
    body { padding: 0; }
    .receipt { max-width: 100%; }
  }
</style></head>
<body><div class="receipt paper-${esc(paper)}">${watermark}
  <div class="center">
    ${p.logoUrl ? `<img src="${esc(p.logoUrl)}" alt="logo" style="max-height:56px"/><br/>` : ""}
    <h1>${esc(p.tradingName || p.legalName)}</h1>
    ${p.tradingName && p.legalName !== p.tradingName ? `<div class="muted">${esc(p.legalName)}</div>` : ""}
    ${p.address ? `<div class="muted">${esc(p.address)}</div>` : ""}
    ${p.phone ? `<div class="muted">${esc(p.phone)}</div>` : ""}
    ${p.email ? `<div class="muted">${esc(p.email)}</div>` : ""}
    ${p.tin ? `<div class="muted">TIN: ${esc(p.tin)}</div>` : ""}
    ${p.ndaLicenseNumber ? `<div class="muted">NDA: ${esc(p.ndaLicenseNumber)}</div>` : ""}
    ${p.receiptHeader ? `<div class="muted">${esc(p.receiptHeader)}</div>` : ""}
  </div>
  <div class="center label ${snapshot.isFiscal ? "" : "nonfiscal"}">${esc(snapshot.documentLabel)}</div>
  <hr/>
  <div class="muted">Receipt: ${esc(snapshot.receiptNumber)}<br/>
    Date: ${esc(snapshot.dateTimeKampala)}
    ${snapshot.branch ? `<br/>Branch: ${esc(snapshot.branch)}` : ""}
    ${snapshot.terminal ? `<br/>Terminal: ${esc(snapshot.terminal)}` : ""}
    ${snapshot.cashier ? `<br/>Served by: ${esc(snapshot.cashier)}` : ""}
    ${snapshot.patientName ? `<br/>Customer: ${esc(snapshot.patientName)}` : ""}
  </div>
  <hr/>
  <table><tbody>${rows}</tbody></table>
  <hr/>
  <table class="totals"><tbody>
    <tr><td>Subtotal</td><td class="r">${money(snapshot.subtotal)}</td></tr>
    ${snapshot.discountTotal > 0 ? `<tr><td>Discount</td><td class="r">-${money(snapshot.discountTotal)}</td></tr>` : ""}
    ${snapshot.tax && snapshot.tax.source === "vat"
      ? `${snapshot.tax.taxableAmount > 0 ? `<tr><td>Taxable${snapshot.tax.ratePct == null ? "" : ` (${formatTaxRate(snapshot.tax.ratePct)}%)`}</td><td class="r">${money(snapshot.tax.taxableAmount)}</td></tr>` : ""}
    ${snapshot.taxAmount > 0 ? `<tr><td>VAT${snapshot.tax.ratePct == null ? "" : ` (${formatTaxRate(snapshot.tax.ratePct)}%)`}</td><td class="r">${money(snapshot.taxAmount)}</td></tr>` : ""}
    ${snapshot.tax.zeroRatedAmount > 0 ? `<tr><td>Zero-rated</td><td class="r">${money(snapshot.tax.zeroRatedAmount)}</td></tr>` : ""}
    ${snapshot.tax.exemptAmount > 0 ? `<tr><td>Exempt</td><td class="r">${money(snapshot.tax.exemptAmount)}</td></tr>` : ""}`
      : snapshot.taxAmount > 0 ? `<tr><td>Tax/VAT</td><td class="r">${money(snapshot.taxAmount)}</td></tr>` : ""}
    <tr><td class="tot">TOTAL</td><td class="r tot">${money(snapshot.totalAmount)}</td></tr>
    <tr><td>Payment</td><td class="r">${esc(snapshot.payment.method)}</td></tr>
    ${snapshot.payment.reference ? `<tr><td>Ref</td><td class="r">${esc(snapshot.payment.reference)}</td></tr>` : ""}
    ${snapshot.payment.amountReceived != null ? `<tr><td>Received</td><td class="r">${money(snapshot.payment.amountReceived)}</td></tr>` : ""}
    ${snapshot.payment.change != null ? `<tr><td>Change</td><td class="r">${money(snapshot.payment.change)}</td></tr>` : ""}
  </tbody></table>
  <hr/>
  <div class="center foot">
    ${
      snapshot.isFiscal
        ? `EFRIS FISCAL DOCUMENT${snapshot.fiscal.documentNumber ? `<br/>Fiscal No: ${esc(snapshot.fiscal.documentNumber)}` : ""}${snapshot.fiscal.verificationCode ? `<br/>Verify: ${esc(snapshot.fiscal.verificationCode)}` : ""}`
        : `<span class="nonfiscal">Not an EFRIS fiscal receipt</span>`
    }
    ${p.supervisingPharmacist ? `<br/>Pharmacist: ${esc(p.supervisingPharmacist)}` : ""}
    ${p.pharmacistRegNumber ? `<br/>Reg: ${esc(p.pharmacistRegNumber)}` : ""}
    ${snapshot.footerNote ? `<br/>${esc(snapshot.footerNote)}` : ""}
    ${snapshot.verificationUrl ? `<br/>Verify: ${esc(snapshot.verificationUrl)}` : ""}
  </div>
</div></body></html>`;
}

