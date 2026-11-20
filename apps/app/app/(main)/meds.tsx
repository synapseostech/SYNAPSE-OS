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
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface Medication {
  id: string
  name: string
  dose: string | null
  frequency: string | null
  notes: string | null
  source: string
}

export default function MedsScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const [medications, setMedications] = useState<Medication[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ medications: Medication[] }>(
        '/api/mobile/medications',
        { token }
      )
      setMedications(data.medications)
    } catch {
      setMedications([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.container}>
      {loading ? (
        <LoadingBlock message="Loading medications…" />
      ) : (
        <FlatList
          data={medications}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load() }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState
              title="No medications tracked"
              body="Prescriptions from Synapse facilities and your health profile will appear here."
              icon="medkit"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/medication/${item.id}` as never)}
            >
              <View style={styles.iconWrap}>
                <Text style={styles.iconLetter}>{item.name[0]?.toUpperCase() ?? 'M'}</Text>
              </View>
              <View style={styles.body}>
                <Text style={styles.name}>{item.name}</Text>
                {(item.dose || item.frequency) ? (
                  <Text style={styles.schedule}>
                    {[item.dose, item.frequency].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {item.notes ? (
                  <Text style={styles.notes} numberOfLines={2}>{item.notes}</Text>
                ) : null}
                <Text style={styles.source}>{item.source}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  cardPressed: { backgroundColor: colors.surfaceHover },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconLetter: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
  },
  body: { flex: 1 },
  name: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  schedule: {
    ...typography.bodySm,
    color: colors.teal,
    fontFamily: 'DMSans_500Medium',
    marginTop: 4,
  },
  notes: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
  source: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
}))
