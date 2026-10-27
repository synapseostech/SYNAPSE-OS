import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission } from "@/lib/tally/auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { TALLY_SYSTEM_ACCOUNT_CODES } from "@synapse/db/tally-map"
import type { TallyAccountOverrides, TallyAccountOverride } from "@synapse/db/tally-map"

const db = () => supabaseAdmin as any

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_OVERRIDES = 2_000

const ACCOUNT_TYPES = new Set(["asset", "liability", "equity", "income", "expense"])
const NORMAL_BALANCES = new Set(["debit", "credit"])
const PARTY_TYPES = new Set(["customer", "supplier"])

type MappingBody = {
  conversionDate?: string
  accountOverrides?: unknown
  productSkuOverrides?: unknown
}

type Cleaned<T> = { ok: true; value: T } | { ok: false; error: string }

function cleanAccountOverrides(raw: unknown): Cleaned<TallyAccountOverrides> {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Account overrides must be an object keyed by Tally ledger name." }
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_OVERRIDES) {
    return { ok: false, error: `Account overrides has too many entries (limit ${MAX_OVERRIDES}).` }
  }

  const cleaned: TallyAccountOverrides = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase()
    if (!key) return { ok: false, error: "An account override has an empty ledger name." }
    if (key.length > 200) return { ok: false, error: "An account override ledger name is too long." }
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      return { ok: false, error: `Account override "${rawKey}" must be an object.` }
    }

    const input = rawValue as Record<string, unknown>
    const override: TallyAccountOverride = {}

    if (input.name !== undefined) {
      const name = String(input.name).trim().replace(/\s+/g, " ")
      if (!name || name.length > 200) {
        return { ok: false, error: `Account override "${rawKey}" needs a display name under 200 characters.` }
      }
      override.name = name
    }
    if (input.accountType !== undefined) {
      const type = String(input.accountType)
      if (!ACCOUNT_TYPES.has(type)) {
        return { ok: false, error: `Account override "${rawKey}" has an unknown account type "${type}".` }
      }
      override.accountType = type as TallyAccountOverride["accountType"]
    }
    if (input.normalBalance !== undefined) {
      const side = String(input.normalBalance)
      if (!NORMAL_BALANCES.has(side)) {
        return { ok: false, error: `Account override "${rawKey}" must have a debit or credit normal balance.` }
      }
      override.normalBalance = side as TallyAccountOverride["normalBalance"]
    }
    if (input.systemKey !== undefined) {
      if (input.systemKey === null) {
        override.systemKey = null
      } else {
        const systemKey = String(input.systemKey).trim()
        if (!(systemKey in TALLY_SYSTEM_ACCOUNT_CODES)) {
          return { ok: false, error: `Account override "${rawKey}" names an unknown system account "${systemKey}".` }
        }
        override.systemKey = systemKey
      }
    }
    if (input.partyType !== undefined) {
      if (input.partyType === null) {
        override.partyType = null
      } else {
        const partyType = String(input.partyType)
        if (!PARTY_TYPES.has(partyType)) {
          return { ok: false, error: `Account override "${rawKey}" must be a customer or a supplier.` }
        }
        override.partyType = partyType as "customer" | "supplier"
      }
    }

    if (Object.keys(override).length === 0) {
      return { ok: false, error: `Account override "${rawKey}" has no fields to apply.` }
    }
    cleaned[key] = override
  }
  return { ok: true, value: cleaned }
}

function cleanSkuOverrides(raw: unknown): Cleaned<Record<string, string>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "SKU overrides must be an object keyed by Tally stock item name." }
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_OVERRIDES) {
    return { ok: false, error: `SKU overrides has too many entries (limit ${MAX_OVERRIDES}).` }
  }

  const cleaned: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase()
    const sku = String(rawValue ?? "").trim()
    if (!key) return { ok: false, error: "A SKU override has an empty stock item name." }
    if (key.length > 200) return { ok: false, error: "A SKU override stock item name is too long." }
    if (!SKU_RE.test(sku)) {
      return { ok: false, error: `SKU override "${rawKey}" has an invalid SKU "${sku}".` }
    }
    cleaned[key] = sku
  }
  return { ok: true, value: cleaned }
}

/**
 * PUT /api/admin/tally/[id]/mapping
 * Saves the reviewer's cut-over date and code overrides. Overrides are keyed by
 * the normalised Tally name, which is what the normaliser looks up.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyPermission(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  let body: MappingBody
  try {
    body = (await request.json()) as MappingBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (body.conversionDate !== undefined && !ISO_DATE_RE.test(String(body.conversionDate))) {
    return NextResponse.json(
      { error: "Cut-over date must be a calendar date in YYYY-MM-DD form." },
      { status: 400 },
    )
  }

  const accounts = cleanAccountOverrides(body.accountOverrides)
  if (!accounts.ok) return NextResponse.json({ error: accounts.error }, { status: 400 })

  const skus = cleanSkuOverrides(body.productSkuOverrides)
  if (!skus.ok) return NextResponse.json({ error: skus.error }, { status: 400 })

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "This import is already being applied; its mapping can no longer change." },
      { status: 409 },
    )
  }

  const mapping = (session.ai_mapping ?? {}) as Record<string, unknown>
  const merged = {
    ...mapping,
    ...(body.conversionDate !== undefined ? { conversionDate: body.conversionDate } : {}),
    ...(body.accountOverrides !== undefined ? { accountOverrides: accounts.value } : {}),
    ...(body.productSkuOverrides !== undefined ? { productSkuOverrides: skus.value } : {}),
    mappingUpdatedAt: new Date().toISOString(),
  }

  const { error: updateError } = await db()
    .from("pharmacy_import_sessions")
    .update({
      ai_mapping: merged,
      status: session.status === "review" ? "mapping" : session.status,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) {
    return NextResponse.json({ error: "The mapping could not be saved." }, { status: 500 })
  }

  return NextResponse.json({
    saved: true,
    conversionDate: merged.conversionDate ?? null,
    accountOverrideCount: Object.keys(accounts.value).length,
    productSkuOverrideCount: Object.keys(skus.value).length,
    needsPreview: true,
  })
}

/** GET — the overrides and system account codes the mapping table renders. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyPermission(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (session.ai_mapping ?? {}) as Record<string, unknown>
  return NextResponse.json({
    status: session.status,
    conversionDate: mapping.conversionDate ?? null,
    accountOverrides: mapping.accountOverrides ?? {},
    productSkuOverrides: mapping.productSkuOverrides ?? {},
    systemAccountCodes: TALLY_SYSTEM_ACCOUNT_CODES,
  })
}
