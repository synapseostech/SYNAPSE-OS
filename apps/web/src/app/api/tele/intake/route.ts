import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { GoogleGenAI } from '@google/genai'
import { verifyToken, validateSession } from '@synapse/auth'
import { SESSION_COOKIE } from '@synapse/config/constants'
import { createServiceClient } from '../../../../lib/supabase/server'
import { checkRateLimit, rateLimiters } from '../../../../lib/rate-limit'

interface IntakeMessage {
  role: 'user' | 'bot'
  content: string
}

const SYSTEM = `You are a compassionate medical triage AI for Synapse OS in Uganda/East Africa. Your job is to assess a patient's symptoms through conversational questions and determine triage urgency.

CONVERSATION FLOW (ask one question at a time):
1. Main symptom / chief complaint
2. Duration (how long?)
3. Severity (1-10 scale)
4. Associated symptoms
5. Relevant history (chronic conditions, medications)
6. Ask 1-2 clarifying questions based on symptoms
7. After collecting enough information (at least 5 exchanges), provide triage assessment

RESPONSE RULES:
- Ask only ONE question per message
- Be warm and clear, avoid medical jargon
- After enough information is gathered (when you have symptom, duration, severity, and associated symptoms), end with JSON triage in this exact format on a NEW line:

TRIAGE_RESULT:{"urgency":"low|medium|high|emergency","recommendation":"your recommendation","summary":"brief clinical summary","action":"book|emergency|home_care"}

DO NOT provide the TRIAGE_RESULT until you have asked at least 4 questions and have sufficient clinical information.
Common East African conditions to consider: malaria, typhoid, HIV, TB, hypertension, diabetes, respiratory infections.`

/** Bounds on what a caller may send. The conversation is replayed on every turn. */
const MAX_MESSAGES = 40
const MAX_CONTENT_LENGTH = 2_000
const MAX_SYMPTOM_LENGTH = 2_000

type DbUrgency = 'routine' | 'priority' | 'urgent'

/**
 * `telemedicine_intake_cases.urgency` allows routine|priority|urgent. The model
 * speaks in low|medium|high|emergency. The original four-level assessment is
 * preserved verbatim inside `triage_summary` and returned to the client; only
 * the indexed column is narrowed. An emergency is stored as `urgent` — the
 * highest level the column can represent.
 */
const URGENCY_MAP: Record<string, DbUrgency> = {
  low: 'routine',
  medium: 'priority',
  high: 'urgent',
  emergency: 'urgent',
}

async function requireSessionUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? null
  if (!token) return null
  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return null
  const { valid } = await validateSession(token)
  if (!valid) return null
  return payload.sub as string
}

function callerKey(req: NextRequest, userId: string | null): string {
  if (userId) return `tele-intake:user:${userId}`
  const forwarded = req.headers.get('x-forwarded-for') ?? ''
  const ip = forwarded.split(',')[0]?.trim()
  return `tele-intake:ip:${ip || 'unknown'}`
}

/** Validates and bounds the conversation. Returns null when the shape is unusable. */
function normaliseMessages(input: unknown): IntakeMessage[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  if (input.length > MAX_MESSAGES) return null

  const out: IntakeMessage[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null
    const { role, content } = raw as { role?: unknown; content?: unknown }
    if (role !== 'user' && role !== 'bot') return null
    if (typeof content !== 'string') return null
    const trimmed = content.trim()
    if (!trimmed) continue
    out.push({ role, content: trimmed.slice(0, MAX_CONTENT_LENGTH) })
  }
  return out.length > 0 ? out : null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  try {
    const sessionUserId = await requireSessionUserId()

    // Public triage chat is a deliberate product surface, so a session is not
    // required. Rate limiting still applies to every caller, keyed on the
    // authenticated user where known and the client address otherwise.
    const { success } = await checkRateLimit(rateLimiters.ai, callerKey(req, sessionUserId))
    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment and try again.' },
        { status: 429 },
      )
    }

    const body = (await req.json().catch(() => null)) as {
      messages?: unknown
      caseId?: unknown
    } | null

    const messages = normaliseMessages(body?.messages)
    if (!messages) {
      return NextResponse.json({ error: 'messages required' }, { status: 400 })
    }

    const suppliedCaseId =
      typeof body?.caseId === 'string' && UUID_PATTERN.test(body.caseId) ? body.caseId : null

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      console.error('[tele/intake] GEMINI_API_KEY is not configured')
      return NextResponse.json(
        { error: 'Triage is temporarily unavailable', code: 'AI_UNAVAILABLE' },
        { status: 503 },
      )
    }

    const genAI = new GoogleGenAI({ apiKey })

    const conversation = messages
      .map((m) => `${m.role === 'user' ? 'Patient' : 'Triage AI'}: ${m.content}`)
      .join('\n')

    const prompt = `${SYSTEM}\n\nConversation:\n${conversation}\n\nTriage AI:`

    const result = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
    })

    const text = (result.text ?? '').trim()

    let reply = text
    let triage: Record<string, unknown> | null = null
    let done = false

    if (text.includes('TRIAGE_RESULT:')) {
      const parts = text.split('TRIAGE_RESULT:')
      reply = (parts[0] ?? '').trim()
      try {
        const parsed = JSON.parse((parts[1] ?? '').trim().split('\n')[0]!)
        if (parsed && typeof parsed === 'object') {
          triage = parsed as Record<string, unknown>
          done = true
        }
      } catch {
        /* malformed triage: the reply is still returned, the case stays open */
      }
    }

    let activeCaseId: string | null = null
    let persisted = false

    // Persistence is best-effort and never changes the clinical reply. Failures
    // are reported to the caller instead of being swallowed.
    if (sessionUserId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = createServiceClient() as any

        // Resolve the caller's tenant server-side. Never read a tenant from the
        // request body: the accepted shape is { messages?, caseId? } only.
        const { data: profile } = await db
          .from('profiles')
          .select('tenant_id')
          .eq('id', sessionUserId)
          .maybeSingle()
        const tenantId = typeof profile?.tenant_id === 'string' ? profile.tenant_id : null
        if (!tenantId) {
          console.warn('[tele/intake] tenant unresolved for user', { userId: sessionUserId })
        }

        // A supplied case id is only honoured when it belongs to the caller.
        // Anything else is treated as a new conversation rather than appended to.
        // The case's own tenant is preferred for appended messages: the caller's
        // profile tenant may have changed between turns, and a message must never
        // disagree with its parent case.
        let caseTenantId: string | null = tenantId
        if (suppliedCaseId) {
          const { data: owned } = await db
            .from('telemedicine_intake_cases')
            .select('id, tenant_id')
            .eq('id', suppliedCaseId)
            .eq('user_id', sessionUserId)
            .eq('is_deleted', false)
            .maybeSingle()
          if (owned?.id) {
            activeCaseId = owned.id as string
            caseTenantId = owned.tenant_id ?? tenantId
          }
        }

        if (!activeCaseId) {
          const firstUserMessage = messages.find((m) => m.role === 'user')
          const { data: created, error: createError } = await db
            .from('telemedicine_intake_cases')
            .insert({
              user_id: sessionUserId,
              tenant_id: tenantId,
              status: 'open',
              urgency: 'routine',
              symptoms: firstUserMessage?.content.slice(0, MAX_SYMPTOM_LENGTH) ?? null,
            })
            .select('id')
            .single()

          if (createError || !created?.id) {
            console.error('[tele/intake] case insert failed', { code: createError?.code })
          } else {
            activeCaseId = created.id as string
          }
        }

        let messagesStored = false
        if (activeCaseId) {
          const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
          const turns: { role: 'user' | 'assistant'; content: string }[] = []
          if (lastUserMessage) turns.push({ role: 'user', content: lastUserMessage.content })
          if (reply) turns.push({ role: 'assistant', content: reply })

          const { error: messageError } = await db.from('telemedicine_intake_messages').insert(
            turns.map((turn) => ({
              case_id: activeCaseId,
              tenant_id: caseTenantId,
              role: turn.role,
              content: turn.content,
            })),
          )
          messagesStored = !messageError
          if (messageError) {
            console.error('[tele/intake] message insert failed', { code: messageError.code })
          }

          if (done && triage) {
            const rawUrgency = typeof triage.urgency === 'string' ? triage.urgency : ''
            const urgency = URGENCY_MAP[rawUrgency] ?? 'routine'
            if (!URGENCY_MAP[rawUrgency]) {
              console.warn('[tele/intake] unmapped urgency from model', { urgency: rawUrgency })
            }
            const { error: updateError } = await db
              .from('telemedicine_intake_cases')
              .update({
                urgency,
                triage_summary: triage,
                recommendation: {
                  text: triage.recommendation ?? null,
                  action: triage.action ?? null,
                },
              })
              .eq('id', activeCaseId)
              .eq('user_id', sessionUserId)
            if (updateError) {
              console.error('[tele/intake] triage update failed', { code: updateError.code })
            }
          }

          persisted = messagesStored
        }
      } catch (err) {
        console.error('[tele/intake] persistence failed', err instanceof Error ? err.message : err)
      }
    }

    return NextResponse.json({
      reply,
      triage,
      done,
      caseId: persisted ? activeCaseId : null,
      persisted,
    })
  } catch (err) {
    console.error('[tele/intake]', err)
    return NextResponse.json({ error: 'Intake service error' }, { status: 500 })
  }
}
