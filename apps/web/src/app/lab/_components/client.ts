"use client"

export class LabApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

/** JSON fetch for the lab console. Surfaces the server's message, never a raw stack. */
export async function labApi<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const raw = data.message ?? data.error
    const message = typeof raw === "string" ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { formErrors?: string[] }).formErrors) && (raw as { formErrors: string[] }).formErrors[0]
        ? (raw as { formErrors: string[] }).formErrors[0]!
        : res.status === 403 ? "Your role cannot do this." : "Something went wrong. Try again."
    throw new LabApiError(message, res.status, typeof data.code === "string" ? data.code : undefined)
  }
  return data as T
}

/** Open a server-rendered page (label, report) and start the print dialog: "Save as PDF" works there. */
export function openAndPrint(url: string) {
  const w = window.open(url, "_blank", "noopener=no")
  if (!w) {
    window.location.href = url
    return
  }
  w.addEventListener("load", () => {
    w.focus()
    w.print()
  })
}

export const STATUS_LABEL: Record<string, string> = {
  ORDERED: "To collect",
  COLLECTION_PENDING: "To collect",
  COLLECTED: "Collected",
  IN_TRANSIT: "In transit",
  RECEIVED: "In lab",
  PROCESSING: "In lab",
  RESULT_ENTERED: "To authorise",
  VERIFICATION_PENDING: "To authorise",
  VERIFIED: "Verified",
  RELEASED: "Released",
  AMENDED: "Amended",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
}

export const REJECTION_REASONS = [
  ["hemolyzed", "Haemolysed"], ["clotted", "Clotted"], ["insufficient_volume", "Too little sample"],
  ["unlabelled", "Unlabelled"], ["mislabeled", "Mislabelled"], ["wrong_container", "Wrong container"],
  ["leaked", "Leaked"], ["too_old", "Too old"], ["contaminated", "Contaminated"], ["patient_mismatch", "Patient mismatch"], ["other", "Other"],
] as const

export function formatMoney(value: number | null | undefined, currency = "UGX") {
  if (value == null) return "—"
  return `${currency} ${Math.round(value).toLocaleString()}`
}
