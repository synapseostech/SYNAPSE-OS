import { parsePharmacyRpcError, type PharmacyRpcError } from "./inventory-rpc"
import type { TallyReplayState } from "./tally-replay"

/**
 * The replay write path from 20261106120000_pharmacy_tally_stock_replay.sql.
 *
 * `applyTallyReplayMovement` is the only way historical stock moves. One call
 * carries one movement and every batch it touches, because a FEFO sale that
 * spans three batches must commit or fail as one: a call per batch could leave
 * a half-consumed line whose provenance says the line was applied.
 *
 * It is idempotent on the movement's place in the export (`source_type`,
 * `source_id`, `line_index`), so a resumed chunk or a repeated apply is a no-op
 * on stock and creates no batch. Errors come back parsed, so a closed
 * accounting period or a negative-stock refusal reads the same here as it does
 * on the ordinary stock path.
 */

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export type TallyReplayMovementKind =
  | "opening"
  | "purchase_in"
  | "sale_out"
  | "return_in"
  | "return_out"
  | "stock_journal_in"
  | "stock_journal_out"
  | "physical_adjust"

export type TallyReplayAllocation = "explicit" | "fefo" | "synthetic"

export interface TallyReplayAllocationInput {
  /**
   * The allocation's place inside the movement. Together with `lineIndex` it is
   * half of the provenance identity, so it must be stable across a re-run.
   */
  batchIndex: number
  batchNumber: string
  /** YYYY-MM-DD, or null when the export carries no expiry for this batch. */
  expiryDate?: string | null
  /** Signed whole units, already resolved from any physical-stock SET. */
  quantityDelta: number
  rate?: number | null
  amount?: number | null
}

export interface TallyReplayMovementInput {
  tenantId: string
  sessionId: string
  movementId: string
  sourceType: string
  sourceId: string
  sourceGuid?: string | null
  lineIndex: number
  movementKind: TallyReplayMovementKind
  /** YYYY-MM-DD. The date the movement happened, not today. */
  movementDate: string
  productId: string
  godown?: string | null
  /** How the export named the batch: stated, chosen by FEFO, or a synthetic key. */
  allocation: TallyReplayAllocation
  allocations: TallyReplayAllocationInput[]
  /**
   * Set only when the review gate recorded an acknowledgement for this exact
   * movement's blocking negative-stock finding. It is the permission to write a
   * quantity the simulation already reported as negative.
   */
  allowNegative?: boolean
}

export interface TallyReplayAppliedAllocation {
  batchId: string
  batchNumber: string
  batchIndex: number
  quantityDelta: number
  quantityAfter: number
}

export interface TallyReplayMovementResult {
  replayed: boolean
  movementId: string
  /** Empty when `replayed` is true — the stock was moved by the earlier call. */
  allocations: TallyReplayAppliedAllocation[]
  productQuantityAfter: number | null
}

export async function applyTallyReplayMovement(
  client: RpcClient,
  input: TallyReplayMovementInput,
): Promise<{ data: TallyReplayMovementResult | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("apply_pharmacy_tally_replay_movement", {
    p_tenant_id: input.tenantId,
    p_session_id: input.sessionId,
    p_movement_id: input.movementId,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_source_guid: input.sourceGuid ?? null,
    p_line_index: Math.trunc(input.lineIndex),
    p_movement_kind: input.movementKind,
    p_movement_date: String(input.movementDate).slice(0, 10),
    p_product_id: input.productId,
    p_allocation: input.allocation,
    p_godown: input.godown ?? null,
    p_allocations: input.allocations.map((allocation) => ({
      batch_index: Math.trunc(allocation.batchIndex),
      batch_number: allocation.batchNumber.trim(),
      expiry_date: allocation.expiryDate ? String(allocation.expiryDate).slice(0, 10) : null,
      quantity_delta: Math.trunc(allocation.quantityDelta),
      rate: allocation.rate ?? null,
      amount: allocation.amount ?? null,
    })),
    p_allow_negative: input.allowNegative === true,
  })

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) }

  const row = (data ?? {}) as Record<string, unknown>
  const applied = Array.isArray(row.allocations)
    ? (row.allocations as Array<Record<string, unknown>>)
    : []

  return {
    data: {
      replayed: row.replayed === true,
      movementId: String(row.movement_id ?? input.movementId),
      allocations: applied.map((allocation) => ({
        batchId: String(allocation.batch_id ?? ""),
        batchNumber: String(allocation.batch_number ?? ""),
        batchIndex: Number(allocation.batch_index ?? 0),
        quantityDelta: Number(allocation.quantity_delta ?? 0),
        quantityAfter: Number(allocation.quantity_after ?? 0),
      })),
      productQuantityAfter:
        row.product_quantity_after == null ? null : Number(row.product_quantity_after),
    },
    error: null,
  }
}

export interface TallyReplayActualProduct {
  productId: string
  name: string
  quantity: number
}

export interface TallyReplayActualBatch {
  productId: string
  batchNumber: string
  expiryDate: string | null
  quantity: number
}

export interface TallyReplayActualAccount {
  accountId: string
  code: string
  name: string
  normalBalance: "debit" | "credit"
  debit: number
  credit: number
}

export interface TallyReplayActuals {
  products: TallyReplayActualProduct[]
  batches: TallyReplayActualBatch[]
  accounts: TallyReplayActualAccount[]
}

/**
 * The closing position a clean replay reached. A continuation is allowed only
 * from one of these, and its opening stages verify the database against the
 * state stored here rather than re-applying an opening that already landed.
 */
export interface TallyReplayCheckpoint {
  id: string
  companyKey: string
  sessionId: string
  previousId: string | null
  throughDate: string
  closingState: TallyReplayState
  createdAt: string
}

/**
 * Reads the closing state in one uncapped payload. PostgREST would truncate a
 * product list at 1000 rows without saying so, and a truncated comparison is a
 * comparison nobody made.
 */
export async function readTallyReplayActuals(
  client: RpcClient,
  tenantId: string,
): Promise<{ data: TallyReplayActuals | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("pharmacy_tally_replay_actuals", {
    p_tenant_id: tenantId,
  })

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) }

  const payload = (data ?? {}) as Record<string, unknown>
  const rows = (key: string): Array<Record<string, unknown>> => {
    const value = payload[key]
    return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
  }

  return {
    data: {
      products: rows("products").map((row) => ({
        productId: String(row.product_id ?? ""),
        name: String(row.name ?? ""),
        quantity: Number(row.quantity ?? 0),
      })),
      batches: rows("batches").map((row) => ({
        productId: String(row.product_id ?? ""),
        batchNumber: String(row.batch_number ?? ""),
        expiryDate: row.expiry_date ? String(row.expiry_date).slice(0, 10) : null,
        quantity: Number(row.quantity ?? 0),
      })),
      accounts: rows("accounts").map((row) => ({
        accountId: String(row.account_id ?? ""),
        code: String(row.code ?? ""),
        name: String(row.name ?? ""),
        normalBalance: row.normal_balance === "credit" ? "credit" : "debit",
        debit: Number(row.debit ?? 0),
        credit: Number(row.credit ?? 0),
      })),
    },
    error: null,
  }
}

/**
 * Appends the closing position a clean replay reached. The RPC is idempotent
 * on (company, cutoff) for the same session, so a resumed closing stage calls
 * this every time and the checkpoint is still appended once.
 */
export async function recordTallyReplayCheckpoint(
  client: RpcClient,
  input: {
    tenantId: string
    sessionId: string
    companyKey: string
    throughDate: string
    closingState: TallyReplayState
  },
): Promise<{
  data: { id: string; previousId: string | null; throughDate: string; created: boolean } | null
  error: PharmacyRpcError | null
}> {
  const { data, error } = await client.rpc("record_pharmacy_tally_replay_checkpoint", {
    p_tenant_id: input.tenantId,
    p_session_id: input.sessionId,
    p_company_key: input.companyKey,
    p_through_date: String(input.throughDate).slice(0, 10),
    p_closing_state: input.closingState,
  })

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) }

  const row = (data ?? {}) as Record<string, unknown>
  return {
    data: {
      id: String(row.id ?? ""),
      previousId: row.previous_id ? String(row.previous_id) : null,
      throughDate: String(row.through_date ?? input.throughDate).slice(0, 10),
      created: row.created === true,
    },
    error: null,
  }
}

/** The latest checkpoint a company reached, or null when it has none. */
export async function readTallyReplayCheckpoint(
  client: RpcClient,
  tenantId: string,
  companyKey: string,
): Promise<{ data: TallyReplayCheckpoint | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("pharmacy_tally_replay_checkpoint", {
    p_tenant_id: tenantId,
    p_company_key: companyKey,
  })

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) }
  if (data === null || data === undefined) return { data: null, error: null }

  const row = data as Record<string, unknown>
  if (!row.id) return { data: null, error: null }

  const state = (row.closing_state ?? {}) as Partial<TallyReplayState>
  return {
    data: {
      id: String(row.id),
      companyKey: String(row.company_key ?? companyKey),
      sessionId: String(row.session_id ?? ""),
      previousId: row.previous_id ? String(row.previous_id) : null,
      throughDate: String(row.through_date ?? "").slice(0, 10),
      // The state is written by this application, not typed in by a user. A
      // missing block is treated as empty rather than guessed at.
      closingState: {
        accounts: state.accounts ?? {},
        items: state.items ?? [],
        sourceIdsByItem: state.sourceIdsByItem ?? {},
        sourceIdsByAccount: state.sourceIdsByAccount ?? {},
        eventCount: Number(state.eventCount ?? 0),
        ...(state.firstEventDate ? { firstEventDate: state.firstEventDate } : {}),
        ...(state.lastEventDate ? { lastEventDate: state.lastEventDate } : {}),
      },
      createdAt: String(row.created_at ?? ""),
    },
    error: null,
  }
}

export interface TallyReplayReversal {
  sessionId: string
  companyKey: string
  throughDate: string
  movementsReversed: number
  batchesUpdated: number
  productsUpdated: number
}

/**
 * Compensating rollback of a session's stock. The RPC writes an inverse
 * movement per applied movement and refuses once any post-cut-over activity
 * exists, so a refused call wrote nothing.
 */
export async function reverseTallyReplaySession(
  client: RpcClient,
  tenantId: string,
  sessionId: string,
): Promise<{ data: TallyReplayReversal | null; error: PharmacyRpcError | null }> {
  const { data, error } = await client.rpc("reverse_pharmacy_tally_replay_session", {
    p_tenant_id: tenantId,
    p_session_id: sessionId,
  })

  if (error) return { data: null, error: parsePharmacyRpcError(error.message) }

  const row = (data ?? {}) as Record<string, unknown>
  return {
    data: {
      sessionId: String(row.session_id ?? sessionId),
      companyKey: String(row.company_key ?? ""),
      throughDate: String(row.through_date ?? "").slice(0, 10),
      movementsReversed: Number(row.movements_reversed ?? 0),
      batchesUpdated: Number(row.batches_updated ?? 0),
      productsUpdated: Number(row.products_updated ?? 0),
    },
    error: null,
  }
}
