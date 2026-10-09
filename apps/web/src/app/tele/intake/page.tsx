'use client'
export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Bot, Send, User } from 'lucide-react'
import { createClient } from '../../../lib/supabase/client'
import { renderInlineBold } from '../../../lib/safe-text/inline-bold'

interface Message {
  role: 'user' | 'bot'
  content: string
}

type IntakeState = 'chatting' | 'triaged'

interface TriageResult {
  urgency: string
  recommendation: string
  summary: string
  action: 'book' | 'emergency' | 'home_care'
}

const WELCOME = `Hello! I'm your Synapse AI health assistant. I'll ask you a few questions to understand how you're feeling and help you get the right care.

Let's start: **What is your main symptom or concern today?**`

export default function TeleIntakePage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'bot', content: WELCOME },
  ])
  const [input, setInput] = useState('')
  const [state, setState] = useState<IntakeState>('chatting')
  const [triage, setTriage] = useState<TriageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [caseId, setCaseId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')

    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setLoading(true)

    try {
      const supabase = createClient()
      const meRes = await fetch('/api/auth/me')
      const { user } = meRes.ok ? await meRes.json() : { user: null }

      const res = await fetch('/api/tele/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          userId: user?.id,
          caseId,
        }),
      })
      const data = await res.json() as { reply: string; triage?: TriageResult; caseId?: string; done?: boolean }

      if (data.caseId) setCaseId(data.caseId)

      setMessages(prev => [...prev, { role: 'bot', content: data.reply }])

      if (data.done && data.triage) {
        setTriage(data.triage)
        setState('triaged')
      }
    } catch {
      setMessages(prev => [...prev, { role: 'bot', content: 'Sorry, I had trouble connecting. Please try again.' }])
    }
    setLoading(false)
  }

  const urgencyColor = triage?.urgency === 'emergency'
    ? '#EF4444'
    : triage?.urgency === 'high'
      ? '#F97316'
      : triage?.urgency === 'medium'
        ? '#EAB308'
        : '#22C55E'

  return (
    <main className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* Header */}
      <header
        className="flex items-center gap-3 px-4 py-3 border-b"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <Link href="/tele" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)' }}>
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Synapse Triage AI</p>
            <p className="text-xs" style={{ color: '#22C55E' }}>● Online</p>
          </div>
        </div>
      </header>

      {/* Chat */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-24">
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'bot' && (
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full shrink-0 mt-1"
                style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)' }}
              >
                <Bot className="h-4 w-4" />
              </div>
            )}
            <div
              className="max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed"
              style={{
                background: m.role === 'user' ? 'var(--brand-orange)' : 'var(--bg-surface)',
                color: m.role === 'user' ? '#07070A' : 'var(--text-primary)',
                border: m.role === 'bot' ? '1px solid var(--border-edge)' : 'none',
                whiteSpace: 'pre-wrap',
              }}
            >
              {renderInlineBold(m.content)}
            </div>
            {m.role === 'user' && (
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full shrink-0 mt-1"
                style={{ background: 'rgba(249,115,22,0.15)', color: 'var(--brand-orange)' }}
              >
                <User className="h-4 w-4" />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)' }}>
              <Bot className="h-4 w-4" />
            </div>
            <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)' }}>
              <span className="flex gap-1">
                <span className="h-2 w-2 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '0ms' }} />
                <span className="h-2 w-2 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '150ms' }} />
                <span className="h-2 w-2 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        )}

        {/* Triage result */}
        {state === 'triaged' && triage && (
          <div
            className="rounded-2xl p-5 space-y-4"
            style={{ background: 'var(--bg-surface)', border: `2px solid ${urgencyColor}40` }}
          >
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full" style={{ background: urgencyColor }} />
              <p className="font-bold text-sm uppercase tracking-wide" style={{ color: urgencyColor }}>
                {triage.urgency} urgency
              </p>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{triage.recommendation}</p>
            <div className="flex gap-2">
              {triage.action === 'emergency' ? (
                <a
                  href="tel:+256800100066"
                  className="flex-1 rounded-xl py-3 text-center text-sm font-bold transition-all"
                  style={{ background: '#EF4444', color: '#FFFFFF' }}
                >
                  📞 Call Emergency
                </a>
              ) : (
                <Link
                  href={`/tele/book${caseId ? `?caseId=${caseId}` : ''}`}
                  className="flex-1 rounded-xl py-3 text-center text-sm font-bold transition-all"
                  style={{ background: 'var(--brand-orange)', color: '#07070A' }}
                >
                  Book a Doctor
                </Link>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {state === 'chatting' && (
        <div
          className="fixed bottom-0 left-0 right-0 flex items-center gap-2 px-4 py-3 border-t"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Describe your symptoms…"
            className="flex-1 rounded-2xl px-4 py-2.5 text-sm outline-none"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-edge)', color: 'var(--text-primary)' }}
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || loading}
            className="flex h-10 w-10 items-center justify-center rounded-xl transition-all disabled:opacity-40 shrink-0"
            style={{ background: 'var(--brand-orange)', color: '#07070A' }}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      )}
    </main>
  )
}
