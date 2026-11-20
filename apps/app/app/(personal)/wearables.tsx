import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { Screen } from '@/components/ui/Screen'
import { TrendBars } from '@/components/health/TrendBars'
import { useAuth } from '@/lib/auth'
import { clearWearableCache } from '@/lib/personal-store'
import { useWearables } from '@/lib/use-wearables'
import { deviceWearableSource, type SourceStatus } from '@/lib/wearables'
import { disconnectWearable, saveWearableConsent } from '@/lib/wearables-api'
import {
  formatMetric,
  localDay,
  seriesFor,
  WEARABLE_METRICS,
  weeklyTrend,
  type WearableMetric,
} from '@/lib/wearables-core'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export default function WearablesScreen() {
  const { user, token } = useAuth()
  const { colors } = useTheme()
  const source = useMemo(() => deviceWearableSource(), [])
  const { snapshot, syncing, error, reload, syncNow } = useWearables()
  const [status, setStatus] = useState<SourceStatus | null>(null)
  const [chosen, setChosen] = useState<Set<WearableMetric>>(
    () => new Set(WEARABLE_METRICS.filter((m) => m.core).map((m) => m.metric)),
  )
  const [working, setWorking] = useState(false)

  const connection = snapshot.connections.find((c) => c.provider === source.provider)
  const today = localDay(new Date())

  useEffect(() => {
    source.status().then(setStatus).catch(() => setStatus(null))
  }, [source])

  const toggle = (metric: WearableMetric) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(metric)) next.delete(metric)
      else next.add(metric)
      return next
    })

  const connect = async () => {
    if (!token) return
    setWorking(true)
    try {
      const granted = await source.requestAccess(Array.from(chosen))
      if (!granted.length) {
        Alert.alert(
          'Nothing shared',
          `${source.label} did not give Synapse any readings. You can try again, or allow them in ${source.label} settings.`,
        )
        return
      }
      await saveWearableConsent(token, source.provider, granted)
      const fresh = await reload()
      await syncNow(fresh)
    } catch (err) {
      Alert.alert('Could not connect', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setWorking(false)
    }
  }

  const disconnect = () => {
    if (!token || !user) return
    Alert.alert(
      'Disconnect and delete?',
      `Synapse stops reading ${source.label} and deletes every reading it stored from it. Your watch and ${source.label} keep their own data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect and delete',
          style: 'destructive',
          onPress: async () => {
            setWorking(true)
            try {
              await disconnectWearable(token, source.provider)
              await clearWearableCache(user.id)
              await reload()
              Alert.alert(
                'Disconnected',
                `Your readings are deleted from Synapse. To also remove Synapse's permission, open ${source.label} settings.`,
                [
                  { text: 'Done', style: 'cancel' },
                  { text: `Open ${source.label}`, onPress: () => source.openSettings() },
                ],
              )
            } catch (err) {
              Alert.alert('Could not disconnect', err instanceof Error ? err.message : 'Try again.')
            } finally {
              setWorking(false)
            }
          },
        },
      ],
    )
  }

  const shownMetrics = WEARABLE_METRICS.filter((def) => connection?.scopes.includes(def.metric))

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card>
          <View style={styles.sourceRow}>
            <View style={[styles.sourceIcon, { backgroundColor: colors.primarySoft }]}>
              <Ionicons name="watch-outline" size={22} color={colors.primary} />
            </View>
            <View style={styles.flex}>
              <Text style={[styles.sourceTitle, { color: colors.text }]}>{source.label}</Text>
              <Text style={[styles.muted, { color: colors.textSecondary }]}>{source.covers}</Text>
            </View>
          </View>
          {connection ? (
            <Text style={[styles.status, { color: colors.success }]}>
              Connected
              {connection.lastSyncedAt
                ? ` · synced ${new Date(connection.lastSyncedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </Text>
          ) : status && status.state !== 'available' ? (
            <Text style={[styles.status, { color: colors.warning }]}>{status.message}</Text>
          ) : null}
        </Card>

        {!connection ? (
          <>
            <SectionHeader title="Choose what to share" style={styles.spacer} />
            <Card>
              {WEARABLE_METRICS.map((def) => (
                <View key={def.metric} style={styles.metricRow}>
                  <Text style={[styles.metricLabel, { color: colors.text }]}>{def.label}</Text>
                  <Switch
                    value={chosen.has(def.metric)}
                    onValueChange={() => toggle(def.metric)}
                    accessibilityLabel={`Share ${def.label}`}
                  />
                </View>
              ))}
            </Card>
            <Card style={styles.spacer}>
              <Text style={[styles.consentTitle, { color: colors.text }]}>Before you connect</Text>
              <Text style={[styles.consent, { color: colors.textSecondary }]}>
                {'•'} Synapse only reads. It never writes to your watch or {source.label}.{'\n'}
                {'•'} One daily summary per reading is kept on Synapse servers so you can see it on the web
                and on a new phone.{'\n'}
                {'•'} Only you can see it. If you work at a pharmacy, hospital or lab on Synapse, your employer
                and facility admins cannot see it.{'\n'}
                {'•'} Disconnect at any time here, and everything Synapse stored from {source.label} is deleted.
              </Text>
            </Card>
            <Button
              label={`I agree, connect ${source.label}`}
              onPress={connect}
              loading={working}
              disabled={!chosen.size || status?.state !== 'available'}
              style={styles.spacer}
            />
          </>
        ) : (
          <>
            <View style={styles.headerRow}>
              <SectionHeader title="Last 7 days" />
              <Pressable onPress={() => syncNow()} disabled={syncing} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.link, { color: colors.primary }]}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
              </Pressable>
            </View>
            {shownMetrics.map((def) => {
              const trend = weeklyTrend(snapshot.daily, def.metric, today)
              const points = seriesFor(snapshot.daily, def.metric, 7, today)
              const unit = def.metric === 'sleep_minutes' ? '' : def.unit
              return (
                <Card key={def.metric}>
                  <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{def.label}</Text>
                  <View style={styles.valueRow}>
                    <Text style={[styles.value, { color: colors.text }]}>{formatMetric(def.metric, trend.average)}</Text>
                    <Text style={[styles.muted, { color: colors.textMuted }]}>
                      {trend.average === null ? 'no data yet' : `${unit} daily average`}
                    </Text>
                  </View>
                  {trend.changePct !== null ? (
                    <Text style={[styles.muted, { color: colors.textMuted }]}>
                      {trend.direction === 'flat'
                        ? 'About the same as last week'
                        : `${trend.changePct > 0 ? '+' : ''}${trend.changePct}% on last week`}
                    </Text>
                  ) : null}
                  <TrendBars points={points} accessibilityLabel={`${def.label}, last 7 days`} />
                </Card>
              )
            })}
            {error ? <Text style={[styles.muted, { color: colors.warning }]}>{error}</Text> : null}
            <Text style={[styles.muted, styles.spacer, { color: colors.textMuted }]}>
              No readings? Open your watch app (Samsung Health, Fitbit, Mi Fitness…) and switch on sync to{' '}
              {source.label}.
            </Text>
            <Button label="Disconnect and delete" variant="danger" onPress={disconnect} loading={working} style={styles.spacer} />
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md, paddingBottom: spacing.xxxl },
  flex: { flex: 1 },
  spacer: { marginTop: spacing.md },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sourceIcon: { width: 44, height: 44, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  sourceTitle: { ...typography.h3 },
  status: { ...typography.caption, marginTop: spacing.md },
  muted: { ...typography.caption },
  metricRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.xs },
  metricLabel: { ...typography.bodyMedium },
  consentTitle: { ...typography.h4, marginBottom: spacing.sm },
  consent: { ...typography.bodySm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  link: { ...typography.bodyMedium },
  valueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.xs },
  value: { ...typography.stat },
})
