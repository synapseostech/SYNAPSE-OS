import { supabaseAdmin } from "@synapse/db/admin"
import { EMPTY_CONTEXT, NO_CONSENT, type CompanionConsent, type CompanionContext } from "./context"
import type { CompanionStore, ConversationSummary, SafetyKind, StoredMessage } from "./service"
import { normaliseLanguage } from "./safety"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: string): string {
  if (!UUID.test(value)) throw new Error("invalid id")
  return value
}

type ConversationRow = { id: string; title: string; language: string; updated_at: string }
type MessageRow = { id: string; conversation_id: string; role: "user" | "assistant"; content: string; safety_kind: string; created_at: string }

function toSummary(row: ConversationRow): ConversationSummary {
  return { id: row.id, title: row.title, language: normaliseLanguage(row.language), updatedAt: row.updated_at }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    safetyKind: row.safety_kind as SafetyKind,
    createdAt: row.created_at,
  }
}

function day(value: unknown): string {
  if (typeof value !== "string") return ""
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

function joinParts(...parts: Array<unknown>): string {
  return parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== "").map(String).join(" ")
}

/**
 * Reads only rows that belong to `userId` (the verified session subject).
 * Each source is optional: a missing table or column yields no lines rather
 * than failing the chat.
 */
async function loadRecordContext(userId: string): Promise<CompanionContext> {
  const id = assertUuid(userId)
  const out: CompanionContext = { ...EMPTY_CONTEXT, medications: [], appointments: [], readings: [], labs: [], wearables: [] }

  const [orders, profile, labs, appts, patientVitals, appVitals] = await Promise.all([
    db().from("encounter_orders").select("drug_name, dosage, frequency, route, status, created_at")
      .eq("patient_id", id).eq("order_type", "medication").in("status", ["active", "dispensed"])
      .order("created_at", { ascending: false }).limit(15),
    db().from("patient_profiles").select("current_medications").eq("id", id).maybeSingle(),
    db().from("lab_results").select("test_name, result_value, unit, reference_range, flag, created_at")
      .eq("patient_id", id).order("created_at", { ascending: false }).limit(15),
    db().from("telemedicine_appointments").select("scheduled_for, status, chief_complaint, channel")
      .eq("patient_id", id).eq("is_deleted", false).gte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true }).limit(5),
    db().from("patient_vitals").select("systolic_bp, diastolic_bp, heart_rate, temperature, spo2, weight_kg, blood_glucose, source, recorded_at")
      .eq("patient_id", id).order("recorded_at", { ascending: false }).limit(10),
    db().from("app_vitals").select("blood_pressure_systolic, blood_pressure_diastolic, heart_rate, spo2, temperature, weight, steps_today, source, recorded_at")
      .eq("patient_id", id).order("recorded_at", { ascending: false }).limit(10),
  ].map((q) => Promise.resolve(q).catch(() => ({ data: null }))))

  for (const o of (orders.data ?? []) as Array<Record<string, unknown>>) {
    out.medications.push(joinParts(o.drug_name, o.dosage, o.frequency, o.route, `(prescribed ${day(o.created_at)})`))
  }
  const profileMeds = (profile.data as { current_medications?: unknown } | null)?.current_medications
  const list = Array.isArray(profileMeds) ? profileMeds : profileMeds && typeof profileMeds === "object" ? Object.values(profileMeds) : []
  for (const m of list as Array<Record<string, unknown>>) {
    if (m && typeof m === "object") out.medications.push(joinParts(m.name, m.dose, m.frequency, "(health profile)"))
  }
  for (const l of (labs.data ?? []) as Array<Record<string, unknown>>) {
    out.labs.push(joinParts(`${l.test_name}:`, l.result_value, l.unit, l.reference_range ? `(reference ${l.reference_range})` : null, l.flag ? `flag ${l.flag}` : null, day(l.created_at)))
  }
  for (const a of (appts.data ?? []) as Array<Record<string, unknown>>) {
    out.appointments.push(joinParts(day(a.scheduled_for), a.channel, a.status, a.chief_complaint ? `about: ${a.chief_complaint}` : null))
  }
  const vitalsLine = (bpS: unknown, bpD: unknown, v: Record<string, unknown>, extra: string[]) =>
    joinParts(day(v.recorded_at), bpS && bpD ? `BP ${bpS}/${bpD}` : null, v.heart_rate ? `pulse ${v.heart_rate}` : null,
      v.temperature ? `temp ${v.temperature}C` : null, v.spo2 ? `SpO2 ${v.spo2}%` : null, ...extra)
  for (const v of (patientVitals.data ?? []) as Array<Record<string, unknown>>) {
    const line = vitalsLine(v.systolic_bp, v.diastolic_bp, v, [v.weight_kg ? `weight ${v.weight_kg}kg` : "", v.blood_glucose ? `glucose ${v.blood_glucose}` : ""])
    ;(v.source === "wearable" || v.source === "device" ? out.wearables : out.readings).push(line)
  }
  for (const v of (appVitals.data ?? []) as Array<Record<string, unknown>>) {
    const line = vitalsLine(v.blood_pressure_systolic, v.blood_pressure_diastolic, v, [v.weight ? `weight ${v.weight}kg` : "", v.steps_today ? `steps ${v.steps_today}` : ""])
    ;(typeof v.source === "string" && /wearable|watch|fit|health ?connect|device/i.test(v.source) ? out.wearables : out.readings).push(line)
  }
  return out
}

export function createSupabaseCompanionStore(): CompanionStore {
  return {
    async getConsent(userId) {
      const { data } = await db().from("health_companion_consents").select("*").eq("user_id", assertUuid(userId)).maybeSingle()
      if (!data) return { ...NO_CONSENT }
      return {
        medications: data.medications === true,
        appointments: data.appointments === true,
        readings: data.readings === true,
        labs: data.labs === true,
        wearables: data.wearables === true,
        acceptedTermsAt: data.accepted_terms_at ?? null,
      }
    },
    async saveConsent(userId, consent: CompanionConsent) {
      const { error } = await db().from("health_companion_consents").upsert({
        user_id: assertUuid(userId),
        medications: consent.medications,
        appointments: consent.appointments,
        readings: consent.readings,
        labs: consent.labs,
        wearables: consent.wearables,
        accepted_terms_at: consent.acceptedTermsAt,
        updated_at: new Date().toISOString(),
      })
      if (error) throw new Error(error.message)
    },
    loadRecordContext,
    async takeQuota(quotaKey, limit) {
      const { data, error } = await db().rpc("health_companion_take_quota", { p_user_id: assertUuid(quotaKey), p_limit: limit })
      if (error) throw new Error(error.message)
      return typeof data === "number" ? data : null
    },
    async usageToday(quotaKey) {
      const { data } = await db().from("health_companion_usage").select("count")
        .eq("user_id", assertUuid(quotaKey)).eq("used_on", new Date().toISOString().slice(0, 10)).maybeSingle()
      return typeof data?.count === "number" ? data.count : 0
    },
    async getConversation(userId, conversationId) {
      if (!UUID.test(conversationId)) return null
      const { data } = await db().from("health_companion_conversations").select("id, title, language, updated_at")
        .eq("id", conversationId).eq("user_id", assertUuid(userId)).maybeSingle()
      return data ? toSummary(data) : null
    },
    async createConversation(userId, input) {
      const { data, error } = await db().from("health_companion_conversations")
        .insert({ user_id: assertUuid(userId), title: input.title, language: input.language }).select("id").single()
      if (error || !data) throw new Error(error?.message ?? "conversation insert failed")
      return data.id as string
    },
    async listConversations(userId) {
      const { data } = await db().from("health_companion_conversations").select("id, title, language, updated_at")
        .eq("user_id", assertUuid(userId)).order("updated_at", { ascending: false }).limit(30)
      return ((data ?? []) as ConversationRow[]).map(toSummary)
    },
    async listMessages(userId, conversationId, limit = 200) {
      // Newest `limit` messages, returned oldest-first.
      const { data } = await db().from("health_companion_messages").select("id, conversation_id, role, content, safety_kind, created_at")
        .eq("conversation_id", assertUuid(conversationId)).eq("user_id", assertUuid(userId))
        .order("created_at", { ascending: false }).limit(limit)
      return ((data ?? []) as MessageRow[]).map(toMessage).reverse()
    },
    async appendMessages(userId, conversationId, rows) {
      const base = Date.now()
      const { error } = await db().from("health_companion_messages").insert(
        rows.map((r, i) => ({
          conversation_id: assertUuid(conversationId),
          user_id: assertUuid(userId),
          role: r.role,
          content: r.content,
          safety_kind: r.safetyKind,
          provider: r.provider ?? null,
          model: r.model ?? null,
          // Keep the pair ordered even when both rows land in the same millisecond.
          created_at: new Date(base + i).toISOString(),
        })),
      )
      if (error) throw new Error(error.message)
      await db().from("health_companion_conversations").update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId).eq("user_id", userId)
    },
    async deleteConversation(userId, conversationId) {
      if (!UUID.test(conversationId)) return false
      const { data, error } = await db().from("health_companion_conversations").delete()
        .eq("id", conversationId).eq("user_id", assertUuid(userId)).select("id")
      if (error) throw new Error(error.message)
      return (data ?? []).length > 0
    },
    async deleteAllConversations(userId) {
      const { data, error } = await db().from("health_companion_conversations").delete()
        .eq("user_id", assertUuid(userId)).select("id")
      if (error) throw new Error(error.message)
      return (data ?? []).length
    },
  }
}
