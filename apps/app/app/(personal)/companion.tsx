import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { useAuth } from '@/lib/auth'
import {
  buildDeviceContext,
  CONSENT_LABELS,
  deleteCompanionConversation,
  getCompanionState,
  NOT_A_DOCTOR,
  saveCompanionConsent,
  sendCompanionMessage,
  type CompanionLanguage,
  type CompanionMessage,
  type CompanionState,
  type ConsentCategory,
} from '@/lib/companion'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'sw', label: 'Kiswahili' },
  { value: 'lg', label: 'Luganda (beta)' },
] as const

const STARTERS = [
  'Explain my medicines and when I take them',
  'Help me understand my latest results',
  'What should I ask at my next appointment?',
  'Healthy Ugandan meals for this week',
]

export default function CompanionScreen() {
  const { user, token } = useAuth()
  const { colors } = useTheme()
  const [state, setState] = useState<CompanionState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CompanionMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [language, setLanguage] = useState<CompanionLanguage>('en')
  const [editingConsent, setEditingConsent] = useState(false)
  const [termsChecked, setTermsChecked] = useState(false)
  const [draft, setDraft] = useState<Record<ConsentCategory, boolean>>({
    medications: true, appointments: true, readings: true, labs: true, wearables: false,
  })
  const scrollRef = useRef<ScrollViewInstance | null>(null)

  const load = useCallback(
    async (convo: string | null) => {
      if (!token) return
      try {
        const next = await getCompanionState(token, convo)
        setState(next)
        if (convo) setMessages(next.messages)
        if (next.consent.acceptedTermsAt) {
          const { acceptedTermsAt: _ignored, ...flags } = next.consent
          setDraft(flags)
        }
        setError(null)
      } catch {
        setError('The companion needs an internet connection. In an emergency call 112 or 999.')
      }
    },
    [token],
  )

  useEffect(() => {
    void load(null)
  }, [load])

  async function acceptConsent() {
    if (!token) return
    try {
      await saveCompanionConsent(token, draft)
      setEditingConsent(false)
      await load(conversationId)
    } catch {
      setError('Could not save your choices. Try again.')
    }
  }

  async function send(text?: string) {
    const content = (text ?? input).trim()
    if (!content || sending || !token || !user?.id) return
    setInput('')
    setSending(true)
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content, safetyKind: 'none' }])
    const deviceContext = state ? await buildDeviceContext(user.id, state.consent) : {}
    const result = await sendCompanionMessage(token, { message: content, conversationId, language, deviceContext })
    if (result.conversationId) setConversationId(result.conversationId)
    setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: result.reply, safetyKind: result.safetyKind }])
    setSending(false)
    void load(null)
  }

  function confirmDelete(target: string | 'all') {
    Alert.alert(
      target === 'all' ? 'Delete all conversations?' : 'Delete this conversation?',
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!token) return
            await deleteCompanionConversation(token, target).catch(() => undefined)
            if (target === 'all' || target === conversationId) {
              setConversationId(null)
              setMessages([])
            }
            await load(null)
          },
        },
      ],
    )
  }

  const needsConsent = state ? !state.consent.acceptedTermsAt || editingConsent : false
  const callNumber = (n: string) => Linking.openURL(`tel:${n}`).catch(() => undefined)

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.notice, { backgroundColor: colors.primarySoft, borderColor: colors.border }]} accessibilityRole="text">
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
            <Text style={[styles.noticeText, { color: colors.textSecondary }]}>{NOT_A_DOCTOR}</Text>
          </View>

          <ChoiceChips label="Language" options={LANGUAGES} value={language} onChange={setLanguage} />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
          {state && !state.providerConfigured ? (
            <Text style={[styles.muted, { color: colors.textMuted }]}>
              The companion is not switched on yet. Emergency guidance still works.
            </Text>
          ) : null}

          {state && needsConsent ? (
            <Card style={styles.gap}>
              <Text style={[styles.title, { color: colors.text }]}>What may the companion see?</Text>
              <Text style={[styles.body, { color: colors.textSecondary }]}>
                Only your own records, and only what you allow. You can change this or delete your conversations at any time.
              </Text>
              {CONSENT_LABELS.map((c) => (
                <View key={c.key} style={styles.switchRow}>
                  <View style={styles.flex}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{c.label}</Text>
                    <Text style={[styles.muted, { color: colors.textMuted }]}>{c.hint}</Text>
                  </View>
                  <Switch
                    value={draft[c.key]}
                    onValueChange={(v) => setDraft((d) => ({ ...d, [c.key]: v }))}
                    accessibilityLabel={`Share ${c.label}`}
                  />
                </View>
              ))}
              {!state.consent.acceptedTermsAt ? (
                <Pressable style={styles.switchRow} onPress={() => setTermsChecked((v) => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: termsChecked }}>
                  <Ionicons name={termsChecked ? 'checkbox' : 'square-outline'} size={22} color={colors.primary} />
                  <Text style={[styles.body, styles.flex, { color: colors.textSecondary }]}>
                    I understand it is an AI, not a doctor. It won&apos;t diagnose, prescribe or change my doses, and I&apos;ll seek care for anything urgent.
                  </Text>
                </Pressable>
              ) : null}
              <Button
                label={state.consent.acceptedTermsAt ? 'Save' : 'Start using the companion'}
                onPress={acceptConsent}
                disabled={!state.consent.acceptedTermsAt && !termsChecked}
              />
            </Card>
          ) : null}

          {state && !needsConsent && messages.length === 0 ? (
            <View style={styles.gap}>
              {STARTERS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => send(s)}
                  style={({ pressed }) => [styles.starter, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.body, { color: colors.textSecondary }]}>{s}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {messages.map((m) =>
            m.role === 'assistant' && m.safetyKind === 'emergency' ? (
              <View key={m.id} style={[styles.emergency, { backgroundColor: colors.dangerSoft, borderColor: colors.danger }]} accessibilityRole="alert">
                <View style={styles.row}>
                  <Ionicons name="warning" size={18} color={colors.danger} />
                  <Text style={[styles.title, { color: colors.danger }]}>Seek care now</Text>
                </View>
                <Text style={[styles.body, { color: colors.text }]}>{m.content}</Text>
                <View style={styles.row}>
                  {['112', '999'].map((n) => (
                    <Pressable key={n} onPress={() => callNumber(n)} style={[styles.callBtn, { backgroundColor: colors.danger }]} accessibilityRole="button" accessibilityLabel={`Call ${n}`}>
                      <Ionicons name="call" size={16} color="#fff" />
                      <Text style={styles.callText}>Call {n}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <View
                key={m.id}
                style={[
                  styles.bubble,
                  m.role === 'user'
                    ? [styles.userBubble, { backgroundColor: colors.primary }]
                    : [styles.aiBubble, { backgroundColor: colors.surface, borderColor: m.safetyKind === 'none' ? colors.border : colors.warning }],
                ]}
              >
                <Text style={[styles.body, { color: m.role === 'user' ? '#07070A' : colors.text }]}>{m.content}</Text>
              </View>
            ),
          )}
          {sending ? <Text style={[styles.muted, { color: colors.textMuted }]}>Companion is writing…</Text> : null}

          {state ? (
            <View style={styles.footer}>
              <Text style={[styles.muted, { color: colors.textMuted }]}>
                {state.quota.remaining} of {state.quota.limit} messages left today
              </Text>
              <View style={styles.row}>
                {state.consent.acceptedTermsAt ? (
                  <Pressable onPress={() => setEditingConsent((v) => !v)} hitSlop={8}>
                    <Text style={[styles.link, { color: colors.primary }]}>Data sharing</Text>
                  </Pressable>
                ) : null}
                {conversationId ? (
                  <Pressable onPress={() => { setConversationId(null); setMessages([]) }} hitSlop={8}>
                    <Text style={[styles.link, { color: colors.primary }]}>New chat</Text>
                  </Pressable>
                ) : null}
                {state.conversations.length > 0 ? (
                  <Pressable onPress={() => confirmDelete(conversationId ?? 'all')} hitSlop={8}>
                    <Text style={[styles.link, { color: colors.error }]}>{conversationId ? 'Delete chat' : 'Delete all chats'}</Text>
                  </Pressable>
                ) : null}
              </View>
              {!conversationId && state.conversations.length > 0 ? (
                <View style={styles.gap}>
                  {state.conversations.slice(0, 8).map((c) => (
                    <Pressable key={c.id} onPress={() => { setConversationId(c.id); void load(c.id) }} hitSlop={4}>
                      <Text numberOfLines={1} style={[styles.history, { color: colors.textSecondary }]}>
                        {c.title}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.inputBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextInput
            value={input}
            onChangeText={setInput}
            maxLength={2000}
            placeholder="Ask about your health…"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, { color: colors.text }]}
            onSubmitEditing={() => send()}
            returnKeyType="send"
            accessibilityLabel="Message the companion"
          />
          <Pressable
            onPress={() => send()}
            disabled={!input.trim() || sending}
            style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: !input.trim() || sending ? 0.4 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <Ionicons name="send" size={16} color="#07070A" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  gap: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  notice: { flexDirection: 'row', gap: spacing.sm, borderRadius: radii.lg, borderWidth: 1, padding: spacing.md },
  noticeText: { ...typography.caption, flex: 1, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  title: { ...typography.h4 },
  body: { ...typography.bodySm },
  muted: { ...typography.caption, fontFamily: 'DMSans_400Regular' },
  error: { ...typography.caption, textAlign: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { ...typography.bodyMedium },
  starter: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.md },
  bubble: { maxWidth: '85%', borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  userBubble: { alignSelf: 'flex-end' },
  aiBubble: { alignSelf: 'flex-start', borderWidth: 1 },
  emergency: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  callBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  callText: { ...typography.bodyMedium, color: '#fff' },
  footer: { marginTop: spacing.md, gap: spacing.sm },
  link: { ...typography.caption },
  history: { ...typography.bodySm },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, margin: spacing.md, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: 6 },
  input: { flex: 1, ...typography.body, paddingVertical: 6 },
  sendBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.9 },
})
