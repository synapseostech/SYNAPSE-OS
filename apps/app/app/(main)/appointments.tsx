import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

interface Appointment {
  id: string
  scheduledFor: string
  status: string
  chiefComplaint: string | null
  channel: string
  providerName: string | null
  facilityName: string | null
}

const WEB_APP_URL = (
  (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
).replace(/\/$/, '')

export default function AppointmentsScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ appointments: Appointment[] }>(
        '/api/mobile/appointments',
        { token }
      )
      setAppointments(data.appointments)
    } catch {
      setAppointments([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.container}>
      {loading ? (
        <LoadingBlock message="Loading appointments…" />
      ) : (
        <FlatList
          data={appointments}
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
              title="No upcoming visits"
              body="Book a telemedicine consult or clinic visit from the web app."
              icon="calendar"
            />
          }
          ListFooterComponent={
            appointments.length === 0 ? (
              <Pressable
                style={styles.cta}
                onPress={() => Linking.openURL(`${WEB_APP_URL}/telemedicine`).catch(() => {})}
              >
                <Text style={styles.ctaText}>Book a consult on web</Text>
              </Pressable>
            ) : undefined
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/appointment/${item.id}` as never)}
            >
              <View style={styles.cardTop}>
                <Text style={styles.date}>{formatDate(item.scheduledFor)}</Text>
                <StatusBadge status={item.status} />
              </View>
              <Text style={styles.time}>{formatTime(item.scheduledFor)}</Text>
              {item.providerName ? (
                <Text style={styles.provider}>With {item.providerName}</Text>
              ) : null}
              {item.facilityName ? (
                <Text style={styles.facility}>{item.facilityName}</Text>
              ) : null}
              {item.chiefComplaint ? (
                <Text style={styles.complaint} numberOfLines={2}>{item.chiefComplaint}</Text>
              ) : null}
              <Text style={styles.channel}>{item.channel.replace(/_/g, ' ')}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardPressed: { backgroundColor: colors.surfaceHover },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  date: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    flex: 1,
  },
  time: {
    ...typography.h2,
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
    marginTop: spacing.xs,
    fontSize: 20,
  },
  provider: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    marginTop: spacing.sm,
  },
  facility: {
    ...typography.caption,
    color: colors.teal,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  complaint: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
  channel: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
    textTransform: 'capitalize',
  },
  cta: {
    marginTop: spacing.lg,
    alignItems: 'center',
    padding: spacing.lg,
  },
  ctaText: {
    ...typography.bodyMedium,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },
})
