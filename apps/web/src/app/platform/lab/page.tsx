export const dynamic = "force-dynamic"

import Link from "next/link"
import { Beaker, ExternalLink, FlaskConical } from "lucide-react"
import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { formatDateTime, safeConfiguredCount, safeRows } from "../_lib/platform-data"

type DomainEventRow = {
  id?: string
  event_type?: string | null
  correlation_id?: string | null
  source?: string | null
  payload?: Record<string, unknown> | null
  created_at?: string | null
  timestamp?: string | null
}

const LAB_TABLES = ["lab_orders", "lab_specimens", "lab_results"] as const

const GOLDEN_LAB_EVENTS = [
  "LabOrderCreated",
  "SpecimenCollected",
  "SpecimenReceived",
  "LabResultEntered",
  "LabResultVerified",
  "LabResultReleased",
] as const

function countLabel(probe: { status: "OK" | "NOT_CONFIGURED"; count: number | null }) {
  if (probe.status === "NOT_CONFIGURED") return "NOT_CONFIGURED"
  return String(probe.count ?? 0)
}

function countTone(probe: { status: "OK" | "NOT_CONFIGURED"; count: number | null }) {
  if (probe.status === "NOT_CONFIGURED") return "text-amber-300"
  return "text-primary-color"
}

export default async function PlatformLabMonitorPage() {
  await requirePlatformPage("/platform/lab")

  const [orders, specimens, results, recentEvents] = await Promise.all([
    safeConfiguredCount("lab_orders"),
    safeConfiguredCount("lab_specimens"),
    safeConfiguredCount("lab_results"),
    safeRows<DomainEventRow>(
      "synapse_domain_events",
      "id, event_type, correlation_id, source, payload, created_at, timestamp",
      {
        orderBy: "created_at",
        ascending: false,
        limit: 40,
      },
    ),
  ])

  const probes = [
    { table: "lab_orders", label: "Lab orders", probe: orders },
    { table: "lab_specimens", label: "Specimens", probe: specimens },
    { table: "lab_results", label: "Results", probe: results },
  ] as const

  const tablesConfigured = probes.every((row) => row.probe.status === "OK")
  const labEvents = recentEvents.filter((row) =>
    GOLDEN_LAB_EVENTS.includes(row.event_type as (typeof GOLDEN_LAB_EVENTS)[number]),
  )
  const lastGolden =
    labEvents.find((row) => {
      const payload = row.payload ?? {}
      return (
        payload.loincCode === "58413-6" ||
        payload.testName === "Malaria Pf antigen" ||
        String(payload.value ?? "").toLowerCase() === "positive" ||
        row.correlation_id?.includes("malaria") ||
        row.correlation_id?.includes("golden")
      )
    }) ?? labEvents[0] ?? null

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Lab vertical slice"
        title="Malaria lab monitor"
        description="Order → collection → accession → result → verification → clinical return. Counts never pretend missing tables are healthy zeros. Lab capability stays development — this page is observability only."
        actions={
          <Link
            href="/platform/test-center"
            className="inline-flex items-center gap-1.5 rounded-xl border border-subtle px-3 py-2 text-sm text-secondary-color hover:border-[#F97316]/40"
          >
            Test Center <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <section className="rounded-2xl border border-subtle bg-surface p-4">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-5 w-5 text-[#E8B84B]" />
          <div>
            <p className="text-sm font-semibold text-primary-color">
              Schema status: {tablesConfigured ? "TABLES PRESENT" : "NOT_CONFIGURED"}
            </p>
            <p className="mt-1 text-xs text-muted-color">
              Expected tables: {LAB_TABLES.join(", ")}. Missing tables show NOT_CONFIGURED — never 0 as healthy.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {probes.map((row) => (
          <article key={row.table} className="rounded-xl border border-subtle bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-color">{row.label}</p>
            <p className={`mt-2 text-2xl font-bold ${countTone(row.probe)}`}>{countLabel(row.probe)}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-color">{row.table}</p>
            {row.probe.status === "NOT_CONFIGURED" && row.probe.detail ? (
              <p className="mt-2 text-[11px] text-amber-200/80">{row.probe.detail}</p>
            ) : null}
          </article>
        ))}
      </section>

      <section className="rounded-2xl border border-subtle bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Beaker className="h-4 w-4 text-[#E8B84B]" />
          <h2 className="text-sm font-semibold text-primary-color">Last golden-journey lab evidence</h2>
        </div>
        {!lastGolden ? (
          <p className="text-sm text-muted-color">
            No lab domain events found. Run the malaria golden journey from Test Center, then refresh.
          </p>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-color">Event</dt>
              <dd className="mt-1 font-mono text-sm text-primary-color">{lastGolden.event_type ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-color">When</dt>
              <dd className="mt-1 text-sm text-secondary-color">
                {formatDateTime(lastGolden.created_at ?? lastGolden.timestamp)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-color">Correlation</dt>
              <dd className="mt-1 break-all font-mono text-xs text-muted-color">
                {lastGolden.correlation_id ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-color">Source</dt>
              <dd className="mt-1 text-sm text-secondary-color">{lastGolden.source ?? "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[11px] uppercase tracking-wide text-muted-color">Payload</dt>
              <dd className="mt-1">
                <pre className="max-h-40 overflow-auto rounded-lg border border-subtle bg-base p-3 text-[11px] text-slate-400">
                  {JSON.stringify(lastGolden.payload ?? {}, null, 2)}
                </pre>
              </dd>
            </div>
          </dl>
        )}
        <p className="mt-4 text-xs text-muted-color">
          Slice events: {GOLDEN_LAB_EVENTS.join(" → ")}
        </p>
      </section>
    </div>
  )
}
