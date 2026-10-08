import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin } from "@synapse/db/admin"
import { assertCallerCannotSupplyTenant } from "@synapse/interop"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"
import { isContextError, requireHospitalCapability } from "@/lib/hospital-shared"
import {
  adviseClinical,
  buildClinicalContext,
  clinicalIntelligenceDisabledResponse,
  isClinicalIntelligenceWave1Enabled,
  recordClinicianOverride,
} from "../../../../../lib/clinical-intelligence"
import { loadEncounterScope } from "../../../../../lib/clinical-intelligence/encounter-scope"
import { recordAdviceEvent } from "../../../../../lib/clinical-intelligence/provenance"
import { CLINICIAN_DECISIONS } from "../../../../../lib/clinical-intelligence/schemas"
import { checkRateLimit, rateLimiters } from "../../../../../lib/rate-limit"

export const dynamic = "force-dynamic"

const shortText = z.string().trim().max(500)
const vitalValue = z.union([z.number().finite(), z.string().max(40)])

const overrideSchema = z.object({
  recommendationId: z.string().trim().min(1).max(128),
  decision: z.enum(CLINICIAN_DECISIONS),
  reason: z.string().trim().max(2000).nullish(),
  modifiedText: z.string().trim().max(4000).nullish(),
})

const adviseSchema = z.object({
  tenantId: z.string().optional(),
  encounterId: z.string().max(64).nullish(),
  presentingComplaint: z.string().max(2000).optional(),
  vitals: z.record(z.string().max(40), vitalValue.optional()).optional(),
  laboratory: z
    .array(z.object({ test: shortText, value: shortText, flag: z.string().max(40).optional() }))
    .max(50)
    .optional(),
  history: z.array(shortText).max(50).optional(),
  examination: z.array(shortText).max(50).optional(),
  medications: z.array(shortText).max(50).optional(),
  allergies: z.array(shortText).max(50).optional(),
  previousDiagnoses: z.array(shortText).max(50).optional(),
  demographics: z
    .object({ age: z.number().int().min(0).max(130).nullish(), sex: z.string().max(20).nullish() })
    .optional(),
  task: z.enum(["clinical_copilot", "pathway_copilot", "coding_copilot"]).optional(),
  forceMock: z.boolean().optional(),
  override: overrideSchema.optional(),
})

/** Mock output may only be requested where explicitly allowed and never on production. */
function forceMockAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLINICAL_INTELLIGENCE_ALLOW_FORCE_MOCK === "1" && env.VERCEL_ENV !== "production"
}

/**
 * Clinical Intelligence Wave 1 advise endpoint.
 * Feature-flagged OFF by default. Advisory only — never activates pathways,
 * places orders, signs diagnoses or writes clinician documentation.
 */
export async function POST(req: NextRequest) {
  // Flag check first: when OFF nothing else runs (no auth, DB or provider calls).
  if (!isClinicalIntelligenceWave1Enabled()) {
    return NextResponse.json(clinicalIntelligenceDisabledResponse(), { status: 503 })
  }

  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, "encounter", "create", "opd")
  if (cap) return cap

  const { success } = await checkRateLimit(rateLimiters.ai, `clinical-intelligence:${ctx.userId}`)
  if (!success) return NextResponse.json({ error: "Rate limit exceeded", advisory: true }, { status: 429 })

  const parsedBody = adviseSchema.safeParse(await req.json().catch(() => null))
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", advisory: true }, { status: 400 })
  }
  const body = parsedBody.data

  try {
    assertCallerCannotSupplyTenant(body.tenantId, ctx.tenantId)
  } catch {
    return NextResponse.json({ error: "Caller-supplied tenantId is not accepted" }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  let encounter: { encounterId: string; patientId: string | null } | null = null
  if (body.encounterId) {
    const loaded = await loadEncounterScope(db, ctx.tenantId, body.encounterId)
    if (loaded.error) {
      return NextResponse.json({ error: "Encounter lookup failed", advisory: true }, { status: 500 })
    }
    if (!loaded.scope) return NextResponse.json({ error: "Encounter not found" }, { status: 404 })
    encounter = loaded.scope
  }

  if (body.override) {
    const record = recordClinicianOverride({
      recommendationId: body.override.recommendationId,
      decision: body.override.decision,
      clinicianId: ctx.userId,
      reason: body.override.reason ?? null,
      modifiedText: body.override.modifiedText ?? null,
    })
    const provenance = await recordAdviceEvent(db, {
      tenantId: ctx.tenantId,
      clinicianId: ctx.userId,
      eventType: "override",
      patientId: encounter?.patientId ?? null,
      encounterId: encounter?.encounterId ?? null,
      recommendationId: record.recommendationId,
      task: body.task ?? "clinical_copilot",
      provider: null,
      model: null,
      decision: record.decision,
      payload: { reason: record.reason, modifiedText: record.modifiedText, at: record.at },
    })
    return NextResponse.json({
      ok: true,
      advisory: true,
      override: record,
      provenancePersisted: provenance.persisted,
    })
  }

  const complaint = (body.presentingComplaint ?? "").trim()
  if (!complaint) {
    return NextResponse.json({ error: "presentingComplaint is required", advisory: true }, { status: 400 })
  }

  try {
    const packet = buildClinicalContext({
      tenantId: ctx.tenantId,
      clinicianId: ctx.userId,
      patientId: encounter?.patientId ?? undefined,
      encounterId: encounter?.encounterId ?? null,
      facilityId: ctx.hospitalId ?? null,
      presentingComplaint: complaint,
      vitals: body.vitals,
      laboratory: body.laboratory,
      history: body.history,
      examination: body.examination,
      medications: body.medications,
      allergies: body.allergies,
      previousDiagnoses: body.previousDiagnoses,
      demographics: body.demographics,
    })

    const advice = await adviseClinical({
      packet,
      task: body.task ?? "clinical_copilot",
      forceMock: body.forceMock === true && forceMockAllowed(),
    })

    const provenance = await recordAdviceEvent(db, {
      tenantId: ctx.tenantId,
      clinicianId: ctx.userId,
      eventType: "advice",
      patientId: encounter?.patientId ?? null,
      encounterId: encounter?.encounterId ?? null,
      recommendationId: advice.recommendation.id,
      task: body.task ?? "clinical_copilot",
      provider: advice.provider,
      model: advice.model,
      decision: null,
      payload: {
        recommendation: advice.recommendation.recommendation,
        confidence: advice.recommendation.confidence,
        degraded: advice.degraded,
        degradedReason: advice.degradedReason,
        icd11Candidates: advice.icd11Candidates.map((c) => c.stemCode),
        suggestedPathwayId: advice.recommendation.suggestedPathwayId ?? null,
        promptVersion: advice.provenance.promptVersion,
        toolVersion: advice.provenance.toolVersion,
      },
    })

    return NextResponse.json({ ...advice, provenancePersisted: provenance.persisted })
  } catch {
    return NextResponse.json({ error: "Advice could not be generated", advisory: true }, { status: 400 })
  }
}
