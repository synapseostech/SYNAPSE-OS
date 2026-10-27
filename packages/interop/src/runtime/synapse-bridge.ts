/**
 * Bridge from the existing `SynapseAdapter` SDK to the connector runtime.
 *
 * `src/adapters/sdk.ts` already defines what an adapter can do — pull patients,
 * encounters and results, push patients, orders and prescriptions — and an
 * `AdapterRegistry` that holds them in a process map. What it has never had is
 * durability: no queue, no retry, no dead-letter, no cursor. Registering an
 * adapter made it callable; it did not make delivery reliable.
 *
 * This adapter pair is the join. A `SynapseAdapter` wrapped here becomes a
 * `Connector`, so the relay can drain the outbox into it and report per-message
 * outcomes instead of pretending every call succeeded.
 *
 * Two things it refuses to smooth over:
 *
 *   - A simulation adapter may not receive a non-synthetic record. Silently
 *     pushing real patient data through a simulated peer is the worst failure
 *     available here, so it is a hard, non-retryable refusal.
 *   - The SDK's pull methods take a query, not a cursor. The bridge therefore
 *     pulls one full page per run and reports `hasMore: false`. Incremental pull
 *     needs a modified-since parameter that the canonical contract does not yet
 *     carry; inventing one here would produce a cursor that silently skips
 *     records.
 */

import type { AdapterHealthStatus, SynapseAdapter } from "../adapters/sdk"
import type { CanonicalPerson } from "../canonical"
import type {
  Connector,
  ConnectorCapability,
  ConnectorDescriptor,
  ConnectorHealth,
  ConnectorKind,
  ConnectorResult,
  PullPage,
  PushContext,
} from "./contract"
import { inferRetryable } from "./backoff"

export type OutboundResourceKind = "patient" | "order" | "prescription"

export interface OutboundEnvelope {
  kind: OutboundResourceKind
  resource: Record<string, unknown>
  /**
   * Must be explicitly `false` for real data. Absent is treated as real, so a
   * simulation adapter refuses it — the guard fails closed.
   */
  synthetic?: boolean
}

/** Adapter result codes that will never succeed on retry. */
const TERMINAL_CODES = new Set([
  "INVALID_CODE",
  "IDENTIFIER_MISMATCH",
  "VALIDATION",
  "AUTH",
  "FORBIDDEN",
  "UNMAPPED",
  "ADAPTER_STUB",
  "NO_PID",
  "NO_PID3",
  "SIMULATION_ADAPTER_REFUSED_REAL_DATA",
])

const KIND_BY_SYSTEM: Record<string, ConnectorKind> = {
  tally: "tally",
  tallyprime: "tally",
  dhis2: "dhis2",
  fhir: "fhir",
  hl7: "hl7v2",
  hl7v2: "hl7v2",
  openmrs: "openmrs",
  ugandaemr: "ugandaemr",
  rest: "rest",
}

function kindOf(system: string): ConnectorKind {
  return KIND_BY_SYSTEM[system.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? "other"
}

function toConnectorHealth(status: AdapterHealthStatus, detail: string | undefined, now: Date): ConnectorHealth {
  // `simulation` is not a healthy state for delivery purposes: it means the peer
  // is not a real system. It is reported as degraded rather than down so the
  // distinction survives, but it never reads as `ok`.
  const mapped: ConnectorHealth["status"] =
    status === "healthy" ? "ok" : status === "down" || status === "not_connected" ? "down" : "degraded"
  return {
    status: mapped,
    detail: [status, detail].filter(Boolean).join(": "),
    checkedAt: now.toISOString(),
  }
}

export function wrapSynapseAdapter(
  adapter: SynapseAdapter,
  options: { tenantId: string; capabilities?: ConnectorCapability[]; clock?: () => Date },
): Connector<CanonicalPerson, OutboundEnvelope> {
  const identity = adapter.identify()
  const declared = options.capabilities ?? ["health", "pull", "push"]
  const clock = options.clock ?? (() => new Date())

  const descriptor: ConnectorDescriptor = {
    id: identity.id,
    tenantId: options.tenantId,
    kind: kindOf(identity.system),
    displayName: identity.name,
    capabilities: [...new Set(declared)],
  }

  return {
    describe: () => descriptor,

    async health() {
      try {
        const health = adapter.health()
        return { ok: true, data: toConnectorHealth(health.status, health.detail, clock()) }
      } catch (error) {
        return {
          ok: false,
          code: "CONNECTOR_THREW",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }
      }
    },

    async pull(): Promise<ConnectorResult<PullPage<CanonicalPerson>>> {
      try {
        const result = await adapter.pullPatients({})
        if (!result.ok) {
          return { ok: false, code: result.code, message: result.message, retryable: inferRetryable(result.code) }
        }
        // Full page, no cursor: see the note at the top of this file.
        return {
          ok: true,
          data: { items: result.data, nextCursor: null, hasMore: false },
        }
      } catch (error) {
        return {
          ok: false,
          code: "CONNECTOR_THREW",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }
      }
    },

    async push(batch: OutboundEnvelope[], context: PushContext) {
      const envelope = batch[0]
      if (!envelope) {
        return { ok: false, code: "VALIDATION", message: "empty push batch", retryable: false }
      }

      if (identity.simulation && envelope.synthetic !== true) {
        return {
          ok: false,
          code: "SIMULATION_ADAPTER_REFUSED_REAL_DATA",
          message: `adapter ${identity.id} is simulated and may not receive non-synthetic data (${context.idempotencyKey})`,
          retryable: false,
        }
      }

      try {
        if (envelope.kind === "patient") {
          const result = await adapter.pushPatient(envelope.resource as unknown as CanonicalPerson)
          return result.ok
            ? { ok: true, data: { delivered: 1 } }
            : {
                ok: false,
                code: result.code,
                message: result.message,
                retryable: !TERMINAL_CODES.has(result.code) && inferRetryable(result.code),
              }
        }
        if (envelope.kind === "order") {
          const result = await adapter.pushOrder(envelope.resource)
          return result.ok
            ? { ok: true, data: { delivered: 1 } }
            : {
                ok: false,
                code: result.code,
                message: result.message,
                retryable: !TERMINAL_CODES.has(result.code) && inferRetryable(result.code),
              }
        }
        if (envelope.kind === "prescription") {
          const result = await adapter.pushPrescription(envelope.resource)
          return result.ok
            ? { ok: true, data: { delivered: 1 } }
            : {
                ok: false,
                code: result.code,
                message: result.message,
                retryable: !TERMINAL_CODES.has(result.code) && inferRetryable(result.code),
              }
        }
        return {
          ok: false,
          code: "VALIDATION",
          message: `unknown envelope kind ${JSON.stringify((envelope as { kind?: string }).kind)}`,
          retryable: false,
        }
      } catch (error) {
        return {
          ok: false,
          code: "CONNECTOR_THREW",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }
      }
    },
  }
}
