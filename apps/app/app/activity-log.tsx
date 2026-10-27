import { useCallback, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Card } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

interface AuditLog {
  id: string
  action: string
  entity: string | null
  entityId: string | null
  details: string | null
  createdAt: string
  user: { name: string; role: string }
}

interface ActivityData {
  logs: AuditLog[]
}

const ENTITIES = [
  { value: 'ALL', label: 'All' },
  { value: 'PRODUCT', label: 'Product' },
  { value: 'TRANSACTION', label: 'Sale' },
  { value: 'ORDER', label: 'Order' },
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'USER', label: 'User' },
  { value: 'SETTINGS', label: 'Settings' },
] as const

type EntityFilter = (typeof ENTITIES)[number]['value']

function formatAction(action: string): string {
  return action
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ActivityLogScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const [data, setData] = useState<ActivityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [entity, setEntity] = useState<EntityFilter>('ALL')

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await apiRequest<ActivityData>(
        '/api/mobile/pharmacy/activity-log?limit=200',
        { token },
      )
      setData(result)
    } catch (err) {
      setData(null)
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include the audit log.'
          : 'Could not load the activity log.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const visible = useMemo(() => {
    const rows = data?.logs ?? []
    const needle = query.trim().toLowerCase()
    return rows
      .filter((row) => entity === 'ALL' || row.entity === entity)
      .filter((row) => {
        if (!needle) return true
        return [row.action, row.entity, row.details, row.user.name, row.user.role]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle))
      })
  }, [data, entity, query])

  const actionColor = (action: string) => {
    if (action.includes('CREATE') || action.includes('ADD')) return colors.success
    if (action.includes('DELETE') || action.includes('REMOVE') || action.includes('RESET')) {
      return colors.error
    }
    if (action.includes('UPDATE') || action.includes('EDIT')) return colors.primary
    return colors.textSecondary
  }

  return (
    <ScreenShell title="Activity log" contentStyle={styles.content}>
      {loading ? (
        <LoadingBlock message="Loading activity…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !data ? null : (
        <>
          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Action, person or detail"
            autoCapitalize="none"
          />

          <ChoiceChips label="Entity" options={ENTITIES} value={entity} onChange={setEntity} />

          <Text style={[styles.heading, { color: colors.textMuted }]}>
            {visible.length === data.logs.length
              ? `${data.logs.length} most recent events`
              : `${visible.length} of ${data.logs.length} events`}
          </Text>

          {visible.length === 0 ? (
            <EmptyState
              icon={data.logs.length === 0 ? 'document' : 'search'}
              title={data.logs.length === 0 ? 'No activity yet' : 'No matches'}
              body={
                data.logs.length === 0
                  ? 'Sales, stock changes and staff updates are recorded here as they happen.'
                  : 'Try a different search or entity.'
              }
            />
          ) : (
            <View style={styles.list}>
              {visible.map((row) => (
                <Card key={row.id}>
                  <View style={styles.rowTop}>
                    <Text
                      style={[styles.action, { color: actionColor(row.action) }]}
                      numberOfLines={1}
                    >
                      {formatAction(row.action)}
                    </Text>
                    {row.entity ? (
                      <View style={[styles.entityChip, { backgroundColor: colors.bgElevated }]}>
                        <Text style={[styles.entityText, { color: colors.textSecondary }]}>
                          {row.entity}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={[styles.who, { color: colors.text }]} numberOfLines={1}>
                    {row.user.name}
                    {row.user.role ? ` · ${row.user.role.replace(/_/g, ' ')}` : ''}
                  </Text>
                  {row.details ? (
                    <Text style={[styles.details, { color: colors.textSecondary }]}>
                      {row.details}
                    </Text>
                  ) : null}
                  <Text style={[styles.when, { color: colors.textMuted }]}>
                    {formatWhen(row.createdAt)}
                  </Text>
                </Card>
              ))}
            </View>
          )}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            The audit trail is append-only. Entries cannot be edited or deleted from the app.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  heading: { ...typography.caption },
  list: { gap: spacing.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  action: { ...typography.bodyMedium, fontFamily: 'DMSans_700Bold', flex: 1 },
  entityChip: { borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  entityText: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  who: { ...typography.bodySm, marginTop: spacing.xs },
  details: { ...typography.caption, marginTop: spacing.xs, lineHeight: 18 },
  when: { ...typography.caption, marginTop: spacing.sm },
  message: { ...typography.bodySm },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
