# API Documentation — Pharmacy Inventory & POS (Phase 1)

## Shared domain: `@synapse/db/inventory`
Pure, dependency-free functions — the single source of truth for "sellable" stock. Usable in
Next.js routes, React Native, and tests.

- `summarizeInventory(product, batches, today?) → InventorySummary`
  `{ physicalQuantity, sellableQuantity, expiredQuantity, quarantinedQuantity, damagedQuantity,
  unbatchedQuantity, hasBatches, hasPhantomStock }`. `product.quantity` only feeds `unbatchedQuantity`;
  it is never counted as sellable.
- `allocateFefo(batches, qtyNeeded, { today?, pinBatchId? }) → BatchAllocation[]` — active,
  in-date, positive batches only, earliest-expiry-first; `pinBatchId` = manager manual override.
- `buildStockError({ product, batches, requestedQuantity, today? }) → StructuredStockError | null` —
  `{ productId, productName, requestedQuantity, sellableQuantity, reasonCode, humanMessage,
  recommendedAction }` with `reasonCode ∈ {INSUFFICIENT_STOCK, NO_SELLABLE_BATCHES, PRODUCT_INACTIVE,
  EXPIRED_ONLY, QUARANTINED_ONLY, UNBATCHED_STOCK, REQUIRES_BATCH}`.
- `isSellableBatch`, `normaliseBatch`, `kampalaToday`, `daysUntilExpiry`, `parseRpcStockError`.

## Shared domain: `@synapse/db/import-validation`
- `validateImportRow(row, rowNumber, { today?, requireBatchForStock? })` and
  `validateImportRows(rows, opts)` — require genuine batch number + positive integer quantity +
  non-past expiry to make previously-unbatched medicine sellable; never fabricates batch/expiry.

## HTTP: catalog (updated, additive fields)
`GET /api/mobile/pharmacy/pos/products` and `GET /api/admin/inventory` now also return per product:
`sellableQuantity`, `physicalQuantity`, `expiredQuantity`, `unbatchedQuantity`, `hasPhantomStock`.
`quantity` is retained for backwards compatibility. `batches[]` now lists **only sellable** batches
(active + in-date + positive) and includes each batch's `sellingPrice`. A product may have different
selling prices per batch; the POS price is calculated from the FEFO allocation, not from the shared
catalogue price. **POS clients must validate against `sellableQuantity` and treat the returned
batch allocation/prices as a checkout snapshot.**

`POST /api/admin/pos/complete-sale` and `POST /api/mobile/pharmacy/pos/complete-sale` revalidate
that allocation server-side. The sale RPC payload must contain one line per allocated batch with
`batch_id`, the batch's pre-discount `unit_price`, and that batch's portion of `discount_amount`.
Clients must not send a product-wide price for a multi-batch line. Clinical dispensing uses the
same FEFO batch allocation and batch prices.

## HTTP: checkout error (updated, additive field)
`POST /api/mobile/pharmacy/pos/complete-sale` and `POST /api/admin/pos/complete-sale` — on a stock
failure the JSON now includes `stockError` (the `StructuredStockError` above) alongside the existing
`error` (human string) and `code`. Example:
```json
{ "error": "Not enough stock on active (non-expired) batches for this sale.",
  "code": "INSUFFICIENT_STOCK",
  "stockError": { "productId": "…", "productName": "Amoxicillin 500mg",
    "requestedQuantity": 10, "sellableQuantity": 3, "reasonCode": "INSUFFICIENT_STOCK",
    "humanMessage": "Only 3 of Amoxicillin 500mg is sellable; 10 requested.",
    "recommendedAction": "Reduce the quantity to 3 or receive more stock." } }
```

## Receipts (Phase 3)

### Shared domain: `@synapse/db/receipt`
- `buildReceiptSnapshot({ pharmacy, sale, isReprint? }) → ReceiptSnapshot` — **deep-frozen immutable**
  snapshot of sale-time data (persist it; never re-derive from mutable catalogue rows).
- `isFiscalReceipt(efris)` — true **only** when EFRIS `status === 'accepted'` and a fiscal document
  number exists; otherwise the document is labelled `POS RECEIPT (NON-FISCAL)`.
- `renderReceiptText(snapshot, width?)` — thermal-printer text; `renderReceiptHtml(snapshot)` —
  self-contained print HTML (used by `expo-print` on device to produce the PDF). Reprints/voids/
  refunds carry a watermark.

### HTTP (tenant + pharmacy-role scoped; 404 on cross-tenant sale)
- `GET /api/mobile/pharmacy/sales/:saleId` → `{ sale: ReceiptSnapshot }`
- `GET /api/mobile/pharmacy/sales/:saleId/receipt` → `{ receipt: ReceiptSnapshot }`
- `GET /api/mobile/pharmacy/sales/:saleId/receipt.pdf[?reprint=1]` → `text/html` (device converts to PDF)
- `POST /api/mobile/pharmacy/sales/:saleId/share-log` `{ channel }` → audit a share/print
- `POST /api/mobile/pharmacy/sales/:saleId/reprint` → `{ receipt }` (marked reprint) + audit

## SQL (migration `20260805130000_pharmacy_inventory_authority.sql`)
- View `pharmacy_inventory_summary(product_id, tenant_id, name, product_quantity, physical_quantity,
  sellable_quantity, expired_quantity, quarantined_quantity, damaged_quantity, unbatched_quantity)`.
- `report_unbatched_positive_stock(p_tenant_id uuid)` → legacy phantom-stock report.
- `receive_pharmacy_stock(p_tenant_id, p_product_id, p_batch_number, p_quantity, p_expiry_date,
  p_cost_price?, p_received_by?, p_supplier_ref?) → jsonb` — the sanctioned way to add sellable stock.
- `complete_pharmacy_sale(...)` — unchanged function signature; each item must identify its
  allocated `batch_id` and current pre-discount batch `unit_price`. It excludes non-`active` batches
  and returns a structured `INSUFFICIENT_STOCK` message when stock changes before checkout.
