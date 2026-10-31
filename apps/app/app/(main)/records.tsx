import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { SectionHeader } from '@/components/ui/Card'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

interface HealthRecord {
  id: string
  type: 'encounter' | 'lab' | 'profile'
  title: string
  subtitle: string | null
  date: string
  meta: string | null
}

interface RecordsProfile {
  bloodGroup: string | null
  allergies: string[]
  chronicConditions: string[]
}

export default function RecordsScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const [records, setRecords] = useState<HealthRecord[]>([])
  const [profile, setProfile] = useState<RecordsProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ records: HealthRecord[]; profile: RecordsProfile | null }>(
        '/api/mobile/records',
        { token }
      )
      setRecords(data.records)
      setProfile(data.profile)
    } catch {
      setRecords([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.container}>
      {loading ? (
        <LoadingBlock message="Loading health records…" />
      ) : (
        <FlatList
          data={records}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load() }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            profile ? (
              <View style={styles.profileSection}>
                <SectionHeader title="Health profile" />
                <View style={styles.profileCard}>
                  {profile.bloodGroup ? (
                    <ProfileRow label="Blood group" value={profile.bloodGroup} />
                  ) : null}
                  {profile.allergies.length > 0 ? (
                    <ProfileRow label="Allergies" value={profile.allergies.join(', ')} highlight />
                  ) : null}
                  {profile.chronicConditions.length > 0 ? (
                    <ProfileRow label="Conditions" value={profile.chronicConditions.join(', ')} />
                  ) : null}
                  {!profile.bloodGroup && profile.allergies.length === 0 && profile.chronicConditions.length === 0 ? (
                    <Text style={styles.emptyProfile}>
                      Complete your health profile on the web app for richer records here.
                    </Text>
                  ) : null}
                </View>
                <SectionHeader title="Timeline" />
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            <EmptyState
              title="No records yet"
              body="Visit a Synapse facility or book a consult to start building your health timeline."
              icon="document"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/record/${item.id}` as never)}
            >
              <View style={styles.typePill}>
                <Text style={styles.typeText}>{TYPE_LABELS[item.type]}</Text>
              </View>
              <Text style={styles.title}>{item.title}</Text>
              {item.subtitle ? (
                <Text style={styles.subtitle} numberOfLines={2}>{item.subtitle}</Text>
              ) : null}
              <View style={styles.cardFooter}>
                <Text style={styles.date}>{formatDate(item.date)}</Text>
                {item.meta ? <Text style={styles.meta}>{item.meta}</Text> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const TYPE_LABELS: Record<HealthRecord['type'], string> = {
  encounter: 'Visit',
  lab: 'Lab',
  profile: 'Profile',
}

function ProfileRow({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <View style={styles.profileRow}>
      <Text style={styles.profileLabel}>{label}</Text>
      <Text style={[styles.profileValue, highlight && styles.profileHighlight]}>{value}</Text>
    </View>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  profileSection: { marginBottom: spacing.sm },
  profileCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  profileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  profileLabel: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  profileValue: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    flex: 1,
    textAlign: 'right',
  },
  profileHighlight: { color: colors.warning },
  emptyProfile: {
    ...typography.bodySm,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardPressed: { backgroundColor: colors.surfaceHover },
  typePill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.tealSoft,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginBottom: spacing.sm,
  },
  typeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.teal,
    fontFamily: 'DMSans_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  title: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  subtitle: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  date: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
  meta: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
    textTransform: 'capitalize',
  },
})
