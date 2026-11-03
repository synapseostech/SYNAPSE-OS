/**
 * Shared helpers for pharmacy inventory RPCs used by portal + mobile BFFs.
 * Pure message parsing is client-safe; callers pass their own supabase admin client.
 */

import { parseRpcStockError, type StockReasonCode } from "./inventory";

export interface ReceiveStockInput {
  tenantId: string;
  productId: string;
  batchNumber: string;
  quantity: number;
  expiryDate: string; // YYYY-MM-DD
  costPrice?: number | null;
  sellingPrice?: number | null;
  receivedBy?: string | null;
  supplierRef?: string | null;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
  storeId?: string | null;
  reason?: string | null;
}

export interface ReceiveStockResult {
  ok: true;
  batchId: string;
  productId: string;
  received: number;
}

export interface AdjustBatchInput {
  tenantId: string;
  productId: string;
  /** Absolute CORRECTION quantity for a specific batch, or delta for DECREASE/INCREASE */
  quantity: number;
  type: "INCREASE" | "DECREASE" | "CORRECTION" | "DAMAGE" | "QUARANTINE" | "RECALL";
  reason: string;
  actorId: string;
  batchId?: string | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  costPrice?: number | null;
  /** When restoring via refund, restoreAs controls sellability. Default active for non-Rx operational returns. */
  restoreAs?: "active" | "quarantined";
}

export type PharmacyRpcErrorCode =
  | StockReasonCode
  | "REQUIRES_BATCH"
  | "REQUIRES_EXPIRY"
  | "INVALID_QUANTITY"
  | "EXPIRED_RECEIPT"
  | "PRODUCT_NOT_FOUND"
  | "SUPPLIER_NOT_FOUND"
  | "PURCHASE_ORDER_NOT_FOUND"
  | "STORE_NOT_FOUND"
  | "BATCH_NOT_FOUND"
  | "INSUFFICIENT_BATCH"
  | "STOCK_DRIFT"
  | "ALREADY_REFUNDED"
  | "SALE_NOT_REFUNDABLE"
  | "SALE_NOT_FOUND"
  | "TRANSFER_NOT_FOUND"
  | "TRANSFER_EMPTY"
  | "TRANSFER_STATE_INVALID"
  | "INVALID_TRANSFER_STATE"
  | "PERMISSION"
  | "UNKNOWN";

export interface PharmacyRpcError {
  code: PharmacyRpcErrorCode;
  message: string;
  humanMessage: string;
}

/** Map Postgres raise exception text into pharmacy-language errors. */
export function parsePharmacyRpcError(raw: string | null | undefined): PharmacyRpcError {
  const message = String(raw ?? "Unknown inventory error");
  const codeMatch = message.match(/^([A-Z_]+):/);
  const code = (codeMatch?.[1] ?? "UNKNOWN") as PharmacyRpcErrorCode;
  const parsed = parseRpcStockError(message);

  const normalizedCode =
    code === "INVALID_TRANSFER_STATE" ? "TRANSFER_STATE_INVALID" : code;

  const humanByCode: Partial<Record<PharmacyRpcErrorCode, string>> = {
    REQUIRES_BATCH: "A genuine batch number is required to receive or increase stock.",
    REQUIRES_EXPIRY: "A future expiry date is required to receive stock.",
    INVALID_QUANTITY: "Quantity must be a positive whole number.",
    EXPIRED_RECEIPT: "Cannot receive stock that is already expired.",
    PRODUCT_NOT_FOUND: "Product was not found in this pharmacy.",
    SUPPLIER_NOT_FOUND: "Supplier was not found in this pharmacy.",
    PURCHASE_ORDER_NOT_FOUND: "Purchase order was not found in this pharmacy.",
    STORE_NOT_FOUND: "Store was not found in this pharmacy.",
    BATCH_NOT_FOUND: "The selected batch was not found.",
    INSUFFICIENT_BATCH: "Not enough quantity remains on the selected batch.",
    STOCK_DRIFT:
      "This batch correction would make the product total negative. Reconcile product and batch stock before correcting.",
    INSUFFICIENT_STOCK:
      parsed.productName && parsed.shortBy != null
        ? `Only some units of ${parsed.productName} are sellable; short by ${parsed.shortBy}.`
        : "Not enough sellable stock for this sale.",
    ALREADY_REFUNDED: "This sale has already been refunded or voided.",
    SALE_NOT_REFUNDABLE: "Only completed sales can be refunded.",
    SALE_NOT_FOUND: "This sale was not found in this pharmacy.",
    TRANSFER_NOT_FOUND: "That stock transfer was not found in this pharmacy.",
    TRANSFER_EMPTY: "This transfer has no items or shipped allocations.",
    TRANSFER_STATE_INVALID: "This transfer is not in the right state for that action.",
    INVALID_TRANSFER_STATE: "This transfer is not in the right state for that action.",
    UNBATCHED_STOCK:
      "This product shows stock without batch records. Receive it with genuine batch data before selling.",
  };

  return {
    code: (parsed.reasonCode as PharmacyRpcErrorCode) || (normalizedCode as PharmacyRpcErrorCode),
    message,
    humanMessage:
      humanByCode[normalizedCode as PharmacyRpcErrorCode] ??
      humanByCode[code] ??
      humanByCode[parsed.reasonCode as PharmacyRpcErrorCode] ??
      message.replace(/^[A-Z_]+:\s*/, ""),
  };
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function receivePharmacyStock(
  client: RpcClient,
  input: ReceiveStockInput,
): Promise<{ data: ReceiveStockResult | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("receive_pharmacy_stock", {
    p_tenant_id: input.tenantId,
    p_product_id: input.productId,
    p_batch_number: input.batchNumber.trim(),
    p_quantity: Math.trunc(input.quantity),
    p_expiry_date: String(input.expiryDate).slice(0, 10),
    p_cost_price: input.costPrice ?? null,
    p_received_by: input.receivedBy ?? null,
    p_supplier_ref: input.supplierRef ?? null,
    p_selling_price: input.sellingPrice ?? null,
    p_supplier_id: input.supplierId ?? null,
    p_purchase_order_id: input.purchaseOrderId ?? null,
    p_store_id: input.storeId ?? null,
    p_reason: input.reason ?? null,
  });

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) };

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    data: {
      ok: true,
      batchId: String(row.batch_id ?? ""),
      productId: String(row.product_id ?? input.productId),
      received: Number(row.received ?? input.quantity),
    },
    error: null,
  };
}

export interface PhysicalStockInput {
  tenantId: string;
  productId: string;
  /** Absolute counted quantity — may be negative (Tally Allow Negative Stocks). */
  physicalQty: number;
  reason: string;
  actorId: string;
}

export interface PhysicalStockResult {
  ok: true;
  previousQty: number;
  newQty: number;
  delta: number;
  productId: string;
}

/** Tally-style physical stock voucher: set absolute book quantity. */
export async function setPharmacyPhysicalStock(
  client: RpcClient,
  input: PhysicalStockInput,
): Promise<{ data: PhysicalStockResult | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("set_pharmacy_physical_stock", {
    p_tenant_id: input.tenantId,
    p_product_id: input.productId,
    p_physical_qty: Math.trunc(input.physicalQty),
    p_reason: input.reason,
    p_actor_id: input.actorId,
  });

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) };

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    data: {
      ok: true,
      previousQty: Number(row.previous_qty ?? 0),
      newQty: Number(row.new_qty ?? input.physicalQty),
      delta: Number(row.delta ?? 0),
      productId: String(row.product_id ?? input.productId),
    },
    error: null,
  };
}

export async function adjustPharmacyBatchStock(
  client: RpcClient,
  input: AdjustBatchInput,
): Promise<{ data: Record<string, unknown> | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("adjust_pharmacy_batch_stock", {
    p_tenant_id: input.tenantId,
    p_product_id: input.productId,
    p_quantity: Math.trunc(input.quantity),
    p_type: input.type,
    p_reason: input.reason,
    p_actor_id: input.actorId,
    p_batch_id: input.batchId ?? null,
    p_batch_number: input.batchNumber ?? null,
    p_expiry_date: input.expiryDate ? String(input.expiryDate).slice(0, 10) : null,
    p_cost_price: input.costPrice ?? null,
    p_restore_as: input.restoreAs ?? "active",
  });

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) };
  return { data: (data as Record<string, unknown>) ?? {}, error: null };
}

export async function reversePharmacySale(
  client: RpcClient,
  input: {
    tenantId: string;
    saleId: string;
    actorId: string;
    reason: string;
    /** Default quarantined — dispensed medicines are not blindly re-sellable. */
    restoreAs?: "active" | "quarantined";
  },
): Promise<{ data: Record<string, unknown> | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("reverse_pharmacy_sale", {
    p_tenant_id: input.tenantId,
    p_sale_id: input.saleId,
    p_actor_id: input.actorId,
    p_reason: input.reason,
    p_restore_as: input.restoreAs ?? "quarantined",
  });

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) };
  return { data: (data as Record<string, unknown>) ?? {}, error: null };
}

export interface ShipStockTransferInput {
  tenantId: string;
  transferId: string;
  actorId: string;
}

export interface ShipStockTransferResult {
  ok: true;
  transferId: string;
  status: "in_transit";
  itemsShipped: number;
  unitsShipped: number;
}

/**
 * Ships a draft transfer: FEFO-deducts sellable batches at the source store
 * (never product.quantity) and records the exact source batches consumed so
 * they can be re-created at the destination store on receipt.
 */
export async function shipPharmacyStockTransfer(
  client: RpcClient,
  input: ShipStockTransferInput,
): Promise<{ data: ShipStockTransferResult | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("ship_pharmacy_stock_transfer", {
    p_tenant_id: input.tenantId,
    p_transfer_id: input.transferId,
    p_actor_id: input.actorId,
  });

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) };

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    data: {
      ok: true,
      transferId: String(row.transfer_id ?? input.transferId),
      status: "in_transit",
      itemsShipped: Number(row.items_shipped ?? 0),
      unitsShipped: Number(row.units_shipped ?? 0),
    },
    error: null,
  };
}

export interface ReceiveStockTransferInput {
  tenantId: string;
  transferId: string;
  actorId: string;
}

export interface ReceiveStockTransferResult {
  ok: true;
  transferId: string;
  status: "received";
  allocationsReceived: number;
  unitsReceived: number;
}

/**
 * Receives an in-transit transfer at the destination store: re-creates or
 * tops up the genuine source batch (batch_number + expiry_date + cost_price)
 * so FEFO ordering is preserved across stores.
 */
export async function receivePharmacyStockTransfer(
  client: RpcClient,
  input: ReceiveStockTransferInput,
): Promise<{ data: ReceiveStockTransferResult | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("receive_pharmacy_stock_transfer", {
    p_tenant_id: input.tenantId,
    p_transfer_id: input.transferId,
    p_actor_id: input.actorId,
  });

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) };

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    data: {
      ok: true,
      transferId: String(row.transfer_id ?? input.transferId),
      status: "received",
      allocationsReceived: Number(row.allocations_received ?? 0),
      unitsReceived: Number(row.units_received ?? 0),
    },
    error: null,
  };
}
