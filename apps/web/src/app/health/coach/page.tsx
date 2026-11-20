'use client'
export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bot, Phone, Plus, Send, ShieldCheck, Trash2, User } from 'lucide-react'

type Language = 'en' | 'lg' | 'sw'
type SafetyKind = 'none' | 'emergency' | 'dose_refusal' | 'output_blocked' | 'provider_unavailable'
type Message = { id: string; role: 'user' | 'assistant'; content: string; safetyKind: SafetyKind }
type Conversation = { id: string; title: string; updatedAt: string }
type Consent = {
  medications: boolean
  appointments: boolean
  readings: boolean
  labs: boolean
  wearables: boolean
  acceptedTermsAt: string | null
}
type Category = Exclude<keyof Consent, 'acceptedTermsAt'>
type State = {
  consent: Consent
  conversations: Conversation[]
  messages: Message[]
  quota: { limit: number; used: number; remaining: number }
  providerConfigured: boolean
  emergencyNumbers: Array<{ number: string; label: string }>
}

const CATEGORIES: Array<{ key: Category; label: string; hint: string }> = [
  { key: 'medications', label: 'Medications', hint: 'Prescriptions and your health-profile medicines' },
  { key: 'appointments', label: 'Appointments', hint: 'Upcoming visits and teleconsults' },
  { key: 'readings', label: 'Readings', hint: 'Blood pressure, pulse, temperature, weight' },
  { key: 'labs', label: 'Lab results', hint: 'Recent results and reference ranges' },
  { key: 'wearables', label: 'Wearables', hint: 'Steps and readings from connected devices' },
]

const LANGUAGES: Array<{ value: Language; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'sw', label: 'Kiswahili' },
  { value: 'lg', label: 'Luganda (beta)' },
]

const STARTERS = [
  'Explain my medicines and when I take them',
  'Help me understand my latest lab results in plain language',
  'What should I ask at my next appointment?',
  'Give me a healthy week of Ugandan meals',
]

const NOTICE =
  'Synapse Companion is an AI, not a doctor. It does not diagnose, prescribe or change doses. In an emergency call 112 or 999.'

const LANG_KEY = 'synapse.companion.language'

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const data = (await res.json().catch(() => ({}))) as T
  return { status: res.status, data }
}

export default function HealthCompanionPage() {
  const [state, setState] = useState<State | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [language, setLanguage] = useState<Language>('en')
  const [draftConsent, setDraftConsent] = useState<Record<Category, boolean>>({
    medications: true, appointments: true, readings: true, labs: true, wearables: false,
  })
  const [termsChecked, setTermsChecked] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (convo: string | null) => {
    const q = convo ? `?conversationId=${encodeURIComponent(convo)}` : ''
    const { status, data } = await api<State>(`/api/health/companion${q}`)
    if (status === 401) { setLoadError('Please sign in to use the companion.'); return }
    if (status !== 200) { setLoadError('The companion could not load. Please try again.'); return }
    setState(data)
    if (convo) setMessages(data.messages)
    if (data.consent.acceptedTermsAt) {
      setDraftConsent({
        medications: data.consent.medications, appointments: data.consent.appointments,
        readings: data.consent.readings, labs: data.consent.labs, wearables: data.consent.wearables,
      })
    }
  }, [])

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_KEY)
      if (saved === 'en' || saved === 'lg' || saved === 'sw') setLanguage(saved)
    } catch { /* storage unavailable */ }
    void load(null)
  }, [load])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  function chooseLanguage(value: Language) {
    setLanguage(value)
    try { window.localStorage.setItem(LANG_KEY, value) } catch { /* ignore */ }
  }

  async function saveConsent() {
    const { status } = await api('/api/health/companion/consent', {
      method: 'PUT',
      body: JSON.stringify({ acceptTerms: true, ...draftConsent }),
    })
    if (status === 200) { setShowSettings(false); await load(conversationId) }
  }

  async function send(text?: string) {
    const content = (text ?? input).trim()
    if (!content || sending) return
    setInput('')
    setSending(true)
    setMessages((prev) => [...prev, { id: `tmp-${Date.now()}`, role: 'user', content, safetyKind: 'none' }])
    const { status, data } = await api<{ reply?: string; safetyKind?: SafetyKind; conversationId?: string; error?: string }>(
      '/api/health/companion',
      { method: 'POST', body: JSON.stringify({ message: content, conversationId, language }) },
    )
    let reply = data.reply
    if (!reply) {
      reply =
        status === 429 && data.error === 'daily_limit_reached'
          ? "You've used today's companion messages. They reset tomorrow. In an emergency call 112 or 999."
          : status === 412
            ? 'Please accept the terms above first. If this is urgent, call 112 or 999 or go to the nearest health facility.'
          : status === 429
            ? 'Please wait a minute before sending another message.'
            : 'Sorry, I could not respond right now. Please try again.'
    }
    if (data.conversationId) setConversationId(data.conversationId)
    setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: 'assistant', content: reply!, safetyKind: data.safetyKind ?? 'provider_unavailable' }])
    setSending(false)
    void load(data.conversationId ?? conversationId)
  }

  async function openConversation(id: string) {
    setConversationId(id)
    await load(id)
  }

  function newConversation() {
    setConversationId(null)
    setMessages([])
  }

  async function deleteConversation(id: string) {
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return
    await api(`/api/health/companion?conversationId=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (id === conversationId) newConversation()
    await load(id === conversationId ? null : conversationId)
  }

  async function deleteAll() {
    if (!window.confirm('Delete all your companion conversations? This cannot be undone.')) return
    await api('/api/health/companion?all=1', { method: 'DELETE' })
    newConversation()
    await load(null)
  }

  if (loadError) {
    return <p className="py-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>{loadError}</p>
  }
  if (!state) {
    return <p className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading companion…</p>
  }

  const needsConsent = !state.consent.acceptedTermsAt || showSettings

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-140px)] lg:h-[calc(100vh-80px)]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Health Companion</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            Understand your medicines, results and appointments in plain language.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="companion-language">Language</label>
          <select
            id="companion-language"
            value={language}
            onChange={(e) => chooseLanguage(e.target.value as Language)}
            className="rounded-xl px-2 py-1.5 text-sm"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)', color: 'var(--text-primary)' }}
          >
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          {state.consent.acceptedTermsAt && (
            <button type="button" onClick={() => setShowSettings((v) => !v)} className="rounded-xl px-3 py-1.5 text-sm"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)', color: 'var(--text-secondary)' }}>
              Data sharing
            </button>
          )}
        </div>
      </div>

      <div role="note" className="flex items-start gap-2 rounded-2xl px-3 py-2 text-xs"
        style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.25)', color: 'var(--text-secondary)' }}>
        <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" style={{ color: 'var(--brand-orange)' }} />
        <span>{NOTICE}</span>
      </div>

      {!state.providerConfigured && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          The companion is not switched on for this deployment yet. Emergency guidance still works.
        </p>
      )}

      {needsConsent ? (
        <section className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)' }}>
          <h2 className="text-base font-semibold">What may the companion see?</h2>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            It only ever sees your own records, and only the kinds you allow. You can change this or delete your conversations at any time.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {CATEGORIES.map((c) => (
              <label key={c.key} className="flex items-start gap-2 rounded-xl p-2 text-sm cursor-pointer" style={{ border: '1px solid var(--border-subtle)' }}>
                <input type="checkbox" className="mt-1" checked={draftConsent[c.key]}
                  onChange={(e) => setDraftConsent((d) => ({ ...d, [c.key]: e.target.checked }))} />
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>{c.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {!state.consent.acceptedTermsAt && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={termsChecked} onChange={(e) => setTermsChecked(e.target.checked)} />
              <span>I understand the companion is an AI, not a doctor. It won&apos;t diagnose, prescribe or change my doses, and I&apos;ll seek care for anything urgent.</span>
            </label>
          )}
          <button type="button" onClick={saveConsent}
            disabled={!state.consent.acceptedTermsAt && !termsChecked}
            className="rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40"
            style={{ background: 'var(--brand-orange)', color: '#07070A' }}>
            {state.consent.acceptedTermsAt ? 'Save' : 'Start using the companion'}
          </button>
        </section>
      ) : null}

      <div className="flex flex-1 gap-3 min-h-0">
        <aside className="hidden md:flex w-56 shrink-0 flex-col gap-1 overflow-y-auto">
          <button type="button" onClick={newConversation} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)' }}>
            <Plus className="h-4 w-4" /> New conversation
          </button>
          {state.conversations.map((c) => (
            <div key={c.id} className="group flex items-center gap-1 rounded-xl px-2 py-1.5 text-sm"
              style={{ background: c.id === conversationId ? 'var(--bg-surface)' : 'transparent' }}>
              <button type="button" onClick={() => openConversation(c.id)} className="flex-1 truncate text-left" title={c.title}>{c.title}</button>
              <button type="button" aria-label={`Delete conversation ${c.title}`} onClick={() => deleteConversation(c.id)}
                className="opacity-60 hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          {state.conversations.length > 0 && (
            <button type="button" onClick={deleteAll} className="mt-2 text-xs text-left px-3" style={{ color: 'var(--text-muted)' }}>
              Delete all conversations
            </button>
          )}
        </aside>

        <div className="flex flex-1 flex-col min-w-0">
          <div className="flex-1 overflow-y-auto space-y-3 pb-3">
            {messages.length === 0 && (
              <div className="py-6">
                <div className="flex justify-center mb-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)' }}>
                    <Bot className="h-6 w-6" />
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {STARTERS.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} disabled={!state.consent.acceptedTermsAt}
                      className="rounded-2xl p-3 text-sm text-left disabled:opacity-40"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)', color: 'var(--text-secondary)' }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => m.role === 'assistant' && m.safetyKind === 'emergency' ? (
              <div key={m.id} role="alert" className="rounded-2xl p-4 text-sm space-y-2"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.45)', color: 'var(--text-primary)' }}>
                <p className="flex items-center gap-2 font-semibold" style={{ color: '#ef4444' }}>
                  <AlertTriangle className="h-4 w-4" /> Seek care now
                </p>
                <p className="leading-relaxed">{m.content}</p>
                <div className="flex flex-wrap gap-2">
                  {state.emergencyNumbers.slice(0, 2).map((n) => (
                    <a key={n.number} href={`tel:${n.number}`} className="flex items-center gap-1 rounded-xl px-3 py-1.5 font-semibold"
                      style={{ background: '#ef4444', color: '#fff' }}>
                      <Phone className="h-3.5 w-3.5" /> Call {n.number}
                    </a>
                  ))}
                </div>
              </div>
            ) : (
              <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <div className="flex h-7 w-7 items-center justify-center rounded-full shrink-0 mt-1" style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)' }}>
                    <Bot className="h-4 w-4" />
                  </div>
                )}
                <div className="max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
                  style={{
                    background: m.role === 'user' ? 'var(--brand-orange)' : 'var(--bg-surface)',
                    color: m.role === 'user' ? '#07070A' : 'var(--text-primary)',
                    border: m.role === 'assistant' ? `1px solid ${m.safetyKind === 'none' ? 'var(--border-edge)' : 'rgba(249,115,22,0.45)'}` : 'none',
                  }}>
                  {m.content}
                </div>
                {m.role === 'user' && (
                  <div className="flex h-7 w-7 items-center justify-center rounded-full shrink-0 mt-1" style={{ background: 'rgba(249,115,22,0.15)', color: 'var(--brand-orange)' }}>
                    <User className="h-4 w-4" />
                  </div>
                )}
              </div>
            ))}
            {sending && <p className="text-xs pl-10" style={{ color: 'var(--text-muted)' }}>Companion is writing…</p>}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-center gap-2 rounded-2xl px-3 py-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)' }}>
            <input type="text" value={input} maxLength={2000} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
              placeholder={state.consent.acceptedTermsAt ? 'Ask about your health…' : 'Accept the terms above to start'}
              aria-label="Message the companion"
              className="flex-1 bg-transparent text-sm outline-none" style={{ color: 'var(--text-primary)' }} />
            <button type="button" onClick={() => send()} disabled={!input.trim() || sending} aria-label="Send"
              className="flex h-8 w-8 items-center justify-center rounded-xl disabled:opacity-40"
              style={{ background: 'var(--brand-orange)', color: '#07070A' }}>
              <Send className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {state.quota.remaining} of {state.quota.limit} messages left today · conversations are saved to your account until you delete them
            {conversationId && (
              <button type="button" onClick={() => deleteConversation(conversationId)} className="md:hidden ml-2 underline">Delete this chat</button>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
