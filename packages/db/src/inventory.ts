/**
 * Authoritative pharmacy inventory domain — pure, dependency-free, client-safe.
 *
 * This is the single source of truth for how "sellable" stock is derived from
 * batch rows across every surface (pharmacy web portal, Expo pharmacy app,
 * mobile POS APIs, future hospital pharmacy). It intentionally has **no**
 * runtime dependencies so it can be imported in browsers, React Native, Next.js
 * server routes, and unit tests alike.
 *
 * Batch inventory is authoritative for sellable medicines. `pharmacy_products.quantity`
 * is treated only as a denormalised hint; anything it claims beyond the sum of
 * real batch rows is surfaced as `unbatchedQuantity` (legacy stock that must be
 * given genuine batch information before it can be sold).
 */

/** Batch lifecycle status. Rows with a missing/unknown status are treated as `active` for
 *  forward-compatibility with databases that predate the status column. */
export type BatchStatus =
  | "active"
  | "quarantined"
  | "damaged"
  | "recalled"
  | "expired";

export const SELLABLE_BATCH_STATUS: BatchStatus = "active";

/** Minimal shape needed to reason about a batch. Field names accept both the
 *  API camelCase and DB snake_case variants so callers can pass rows directly. */
export interface BatchInput {
  id?: string | null;
  batchNumber?: string | null;
  batch_number?: string | null;
  quantity?: number | string | null;
  expiryDate?: string | null;
  expiry_date?: string | null;
  status?: BatchStatus | string | null;
  isActive?: boolean | null;
  is_active?: boolean | null;
  manufacturer?: string | null;
  costPrice?: number | string | null;
  cost_price?: number | string | null;
  receivedDate?: string | null;
  received_date?: string | null;
}

export interface ProductInput {
  id?: string | null;
  name?: string | null;
  quantity?: number | string | null;
  isActive?: boolean | null;
  is_active?: boolean | null;
}

/** The authoritative quantity breakdown for one product. */
export interface InventorySummary {
  physicalQuantity: number;
  sellableQuantity: number;
  expiredQuantity: number;
  quarantinedQuantity: number;
  damagedQuantity: number;
  /** Positive `product.quantity` that is NOT backed by any batch row. Never sellable. */
  unbatchedQuantity: number;
  /** True when at least one batch row exists for the product. */
  hasBatches: boolean;
  /** True when product.quantity claims stock that batches cannot substantiate. */
  hasPhantomStock: boolean;
}

export type StockReasonCode =
  | "INSUFFICIENT_STOCK"
  | "NO_SELLABLE_BATCHES"
  | "PRODUCT_INACTIVE"
  | "EXPIRED_ONLY"
  | "QUARANTINED_ONLY"
  | "UNBATCHED_STOCK"
  | "REQUIRES_BATCH";

/** Structured POS error contract (matches the brief's required fields). */
export interface StructuredStockError {
  productId: string;
  productName: string;
  requestedQuantity: number;
  sellableQuantity: number;
  reasonCode: StockReasonCode;
  humanMessage: string;
  recommendedAction: string;
}

export interface BatchAllocation {
  batchId: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  manufacturer: string | null;
  quantity: number;
  costPrice: number | null;
}

// ---------------------------------------------------------------------------
// Date helpers (Africa/Kampala calendar day, matching the sale RPC)
// ---------------------------------------------------------------------------

/** Kampala calendar date as YYYY-MM-DD. */
export function kampalaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Whole days until expiry (negative when already expired), or null when unknown. */
export function daysUntilExpiry(
  expiry: string | null | undefined,
  today: string = kampalaToday(),
): number | null {
  if (!expiry) return null;
  const exp = String(expiry).slice(0, 10);
  const t0 = Date.parse(`${today}T00:00:00Z`);
  const t1 = Date.parse(`${exp}T00:00:00Z`);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.round((t1 - t0) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : 0;
}

function pick<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
}

export interface NormalisedBatch {
  id: string | null;
  batchNumber: string | null;
  quantity: number;
  expiryDate: string | null;
  status: BatchStatus;
  manufacturer: string | null;
  costPrice: number | null;
  receivedDate: string | null;
}

/** Resolve a batch's effective status. A batch that is expired by date is reported as
 *  `expired` regardless of stored status; `is_active === false` maps to `quarantined`
 *  only when no explicit status is present (legacy rows). */
export function normaliseBatch(
  b: BatchInput,
  today: string = kampalaToday(),
): NormalisedBatch {
  const rawStatus = (b.status ?? "").toString().trim().toLowerCase();
  const isActive = pick(b.isActive, b.is_active);
  const expiry = pick(b.expiryDate, b.expiry_date);
  const days = daysUntilExpiry(expiry, today);

  let status: BatchStatus;
  if (
    rawStatus === "active" ||
    rawStatus === "quarantined" ||
    rawStatus === "damaged" ||
    rawStatus === "recalled" ||
    rawStatus === "expired"
  ) {
    status = rawStatus as BatchStatus;
  } else if (isActive === false) {
    // Legacy: deactivated batches are held out of sale; classify as quarantined.
    status = "quarantined";
  } else {
    status = "active";
  }

  // Expiry by date always wins for the sellability decision.
  if (days != null && days < 0) status = "expired";

  return {
    id: pick(b.id) as string | null,
    batchNumber: pick(b.batchNumber, b.batch_number) as string | null,
    quantity: Math.max(0, Math.trunc(num(pick(b.quantity)))),
    expiryDate: expiry,
    status,
    manufacturer: pick(b.manufacturer) as string | null,
    costPrice: (() => {
      const c = pick(b.costPrice, b.cost_price);
      return c == null ? null : num(c);
    })(),
    receivedDate: pick(b.receivedDate, b.received_date) as string | null,
  };
}

export function isSellableBatch(
  b: NormalisedBatch,
  today: string = kampalaToday(),
): boolean {
  if (b.quantity <= 0) return false;
  if (b.status !== "active") return false;
  const days = daysUntilExpiry(b.expiryDate, today);
  if (days != null && days < 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Derive the authoritative quantity breakdown for a product from its batches.
 * `product.quantity` is used ONLY to compute `unbatchedQuantity` (legacy stock
 * not represented by any batch row) — it is never counted as sellable.
 */
export function summarizeInventory(
  product: ProductInput | null,
  batches: BatchInput[] = [],
  today: string = kampalaToday(),
): InventorySummary {
  const norm = batches.map((b) => normaliseBatch(b, today));

  let physical = 0;
  let sellable = 0;
  let expired = 0;
  let quarantined = 0;
  let damaged = 0;

  for (const b of norm) {
    physical += b.quantity;
    if (b.status === "expired") expired += b.quantity;
    else if (b.status === "quarantined") quarantined += b.quantity;
    else if (b.status === "damaged") damaged += b.quantity;
    // 'recalled' is intentionally excluded from all sellable/holding buckets except physical.
    if (isSellableBatch(b, today)) sellable += b.quantity;
  }

  const productQty = Math.max(0, Math.trunc(num(product?.quantity)));
  const unbatched = Math.max(0, productQty - physical);

  return {
    physicalQuantity: physical,
    sellableQuantity: sellable,
    expiredQuantity: expired,
    quarantinedQuantity: quarantined,
    damagedQuantity: damaged,
    unbatchedQuantity: unbatched,
    hasBatches: norm.length > 0,
    hasPhantomStock: unbatched > 0 || (productQty > 0 && sellable === 0),
  };
}

// ---------------------------------------------------------------------------
// FEFO allocation (status- and expiry-aware) — mirrors the sale RPC
// ---------------------------------------------------------------------------

/**
 * Allocate `qtyNeeded` units across sellable batches, earliest-expiry-first.
 * Only `active`, non-expired, positive batches participate. Returns a partial
 * allocation when stock is short (callers must check the summed quantity).
 * When `pinBatchId` is given, allocation is restricted to that batch (manual override).
 */
export function allocateFefo(
  batches: BatchInput[],
  qtyNeeded: number,
  opts: { today?: string; pinBatchId?: string | null } = {},
): BatchAllocation[] {
  const today = opts.today ?? kampalaToday();
  if (!Number.isFinite(qtyNeeded) || qtyNeeded <= 0) return [];

  const sellable = batches
    .map((b) => normaliseBatch(b, today))
    .filter((b) => isSellableBatch(b, today))
    .filter((b) => (opts.pinBatchId ? b.id === opts.pinBatchId : true))
    .sort((a, b) => {
      const ae = a.expiryDate ?? "9999-12-31";
      const be = b.expiryDate ?? "9999-12-31";
      if (ae !== be) return ae.localeCompare(be);
      const ar = a.receivedDate ?? "9999-12-31";
      const br = b.receivedDate ?? "9999-12-31";
      return ar.localeCompare(br);
    });

  let remaining = Math.trunc(qtyNeeded);
  const out: BatchAllocation[] = [];
  for (const b of sellable) {
    if (remaining <= 0) break;
    const take = Math.min(b.quantity, remaining);
    if (take <= 0) continue;
    out.push({
      batchId: b.id,
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      manufacturer: b.manufacturer,
      quantity: take,
      costPrice: b.costPrice,
    });
    remaining -= take;
  }
  return out;
}

export function allocatedQuantity(alloc: BatchAllocation[]): number {
  return alloc.reduce((sum, a) => sum + a.quantity, 0);
}

// ---------------------------------------------------------------------------
// Structured stock errors
// ---------------------------------------------------------------------------

/**
 * Build a structured POS stock error from a product + its batches + the requested qty.
 * Chooses the most specific reason code so the UI can guide the cashier.
 */
export function buildStockError(params: {
  product: ProductInput | null;
  batches: BatchInput[];
  requestedQuantity: number;
  today?: string;
}): StructuredStockError | null {
  const today = params.today ?? kampalaToday();
  const productId = String(params.product?.id ?? "");
  const productName = String(params.product?.name ?? "Unknown product");
  const requested = Math.max(0, Math.trunc(num(params.requestedQuantity)));
  const summary = summarizeInventory(params.product, params.batches, today);

  // Product inactive.
  const active = pick(params.product?.isActive, params.product?.is_active);
  if (active === false) {
    return {
      productId,
      productName,
      requestedQuantity: requested,
      sellableQuantity: summary.sellableQuantity,
      reasonCode: "PRODUCT_INACTIVE",
      humanMessage: `${productName} is inactive and cannot be sold.`,
      recommendedAction: "Re-activate the product in Inventory before selling.",
    };
  }

  if (summary.sellableQuantity >= requested) return null; // sellable — no error

  // No sellable batches at all.
  if (summary.sellableQuantity === 0) {
    if (summary.unbatchedQuantity > 0 && !summary.hasBatches) {
      return {
        productId,
        productName,
        requestedQuantity: requested,
        sellableQuantity: 0,
        reasonCode: "UNBATCHED_STOCK",
        humanMessage: `${productName} shows ${summary.unbatchedQuantity} in stock but has no batch records, so it is not sellable.`,
        recommendedAction:
          "Receive this stock with a genuine batch number, quantity and expiry date before selling.",
      };
    }
    if (summary.expiredQuantity > 0 && summary.quarantinedQuantity === 0 && summary.damagedQuantity === 0) {
      return {
        productId,
        productName,
        requestedQuantity: requested,
        sellableQuantity: 0,
        reasonCode: "EXPIRED_ONLY",
        humanMessage: `All available ${productName} batches are expired.`,
        recommendedAction: "Quarantine or dispose of expired batches and receive fresh stock.",
      };
    }
    if (summary.quarantinedQuantity > 0 && summary.expiredQuantity === 0) {
      return {
        productId,
        productName,
        requestedQuantity: requested,
        sellableQuantity: 0,
        reasonCode: "QUARANTINED_ONLY",
        humanMessage: `All available ${productName} batches are quarantined, damaged or recalled.`,
        recommendedAction: "Release a batch from quarantine (manager) or receive new stock.",
      };
    }
    return {
      productId,
      productName,
      requestedQuantity: requested,
      sellableQuantity: 0,
      reasonCode: "NO_SELLABLE_BATCHES",
      humanMessage: `${productName} has no sellable (active, in-date) batches.`,
      recommendedAction: "Receive new stock with valid batch and expiry information.",
    };
  }

  // Some sellable stock, but not enough.
  return {
    productId,
    productName,
    requestedQuantity: requested,
    sellableQuantity: summary.sellableQuantity,
    reasonCode: "INSUFFICIENT_STOCK",
    humanMessage: `Only ${summary.sellableQuantity} of ${productName} is sellable; ${requested} requested.`,
    recommendedAction: `Reduce the quantity to ${summary.sellableQuantity} or receive more stock.`,
  };
}

/**
 * Enrich a raw RPC error message (e.g. `INSUFFICIENT_STOCK: Amoxicillin short by 3 units`)
 * into the structured contract when the catalogue context is available.
 */
export function parseRpcStockError(
  message: string,
): { reasonCode: StockReasonCode | null; shortBy: number | null; productName: string | null } {
  // Linear parsing (CodeQL js/polynomial-redos #4): RPC messages are short,
  // cap them, then locate markers with indexOf instead of lazy regex groups.
  const msg = String(message ?? "").slice(0, 2000);
  const code = msg.match(/^([A-Z_]{1,64}):/)?.[1] ?? null;
  const shortMatch = msg.match(/short by (\d{1,12})/i);
  const colon = msg.indexOf(":");
  const shortAt = msg.toLowerCase().indexOf("short by", colon + 1);
  const rawName = colon !== -1 && shortAt > colon ? msg.slice(colon + 1, shortAt).trim() : "";
  const reasonCode: StockReasonCode | null =
    code === "INSUFFICIENT_STOCK" ||
    code === "NO_SELLABLE_BATCHES" ||
    code === "PRODUCT_INACTIVE" ||
    code === "EXPIRED_ONLY" ||
    code === "QUARANTINED_ONLY" ||
    code === "UNBATCHED_STOCK" ||
    code === "REQUIRES_BATCH"
      ? code
      : null;
  return {
    reasonCode,
    shortBy: shortMatch?.[1] != null ? Number(shortMatch[1]) : null,
    productName: rawName || null,
  };
}
