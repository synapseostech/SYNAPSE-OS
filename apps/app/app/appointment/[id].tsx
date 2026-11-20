import { useEffect, useState } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface AppointmentDetail {
  id: string
  scheduledFor: string
  status: string
  chiefComplaint: string | null
  channel: string
  providerName: string | null
  facilityName: string | null
  notes: string | null
  canCancel: boolean
}

export default function AppointmentDetailScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const router = useRouter()
  const [appointment, setAppointment] = useState<AppointmentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id || !token) { setLoading(false); return }
    apiRequest<{ appointment: AppointmentDetail }>(`/api/mobile/appointments/${id}`, { token })
      .then((data) => setAppointment(data.appointment))
      .catch(() => setError('Failed to load appointment'))
      .finally(() => setLoading(false))
  }, [id, token])

  const handleCancel = () => {
    Alert.alert(
      'Cancel appointment',
      'Are you sure you want to cancel this appointment?',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel appointment',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true)
            try {
              await apiRequest(`/api/mobile/appointments/${id}`, { method: 'DELETE', token })
              setAppointment((prev) => prev ? { ...prev, status: 'cancelled_by_patient', canCancel: false } : prev)
            } catch {
              Alert.alert('Error', 'Could not cancel the appointment. Please try again.')
            } finally {
              setCancelling(false)
            }
          },
        },
      ]
    )
  }

  if (loading) {
    return <View style={styles.center}><LoadingBlock message="Loading appointment…" /></View>
  }

  if (error || !appointment) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Appointment not found'}</Text>
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={20} color={colors.primary} />
        <Text style={styles.backLabel}>Appointments</Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.dateBlock}>
          <Text style={styles.dateDay}>{formatDay(appointment.scheduledFor)}</Text>
          <Text style={styles.dateMonth}>{formatMonth(appointment.scheduledFor)}</Text>
        </View>
        <View style={styles.headerInfo}>
          <Text style={styles.time}>{formatTime(appointment.scheduledFor)}</Text>
          <Text style={styles.channel}>{appointment.channel.replace(/_/g, ' ')}</Text>
        </View>
        <StatusBadge status={appointment.status} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Details</Text>
        <View style={styles.card}>
          {appointment.providerName ? (
            <InfoRow label="Provider" value={`With ${appointment.providerName}`} />
          ) : null}
          {appointment.facilityName ? (
            <InfoRow label="Facility" value={appointment.facilityName} />
          ) : null}
          {appointment.chiefComplaint ? (
            <InfoRow label="Reason" value={appointment.chiefComplaint} />
          ) : null}
        </View>
      </View>

      {appointment.notes ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <View style={[styles.card, styles.notesCard]}>
            <Text style={styles.notesText}>{appointment.notes}</Text>
          </View>
        </View>
      ) : null}

      {appointment.canCancel ? (
        <Button
          label={cancelling ? 'Cancelling…' : 'Cancel appointment'}
          onPress={handleCancel}
          variant="ghost"
          style={styles.cancelBtn}
        />
      ) : null}
    </ScrollView>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles()
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  )
}

function formatDay(iso: string) { return new Date(iso).getDate().toString() }
function formatMonth(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: 'short', year: 'numeric' })
}
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  center: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl, gap: spacing.lg },
  errorText: { ...typography.body, color: colors.error, fontFamily: 'DMSans_400Regular', textAlign: 'center' },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl, gap: 4 },
  backLabel: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_500Medium' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xxxl, backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  dateBlock: { alignItems: 'center', backgroundColor: colors.primarySoft, borderRadius: radii.md, padding: spacing.md, minWidth: 52 },
  dateDay: { fontSize: 26, fontWeight: '700', color: colors.primary, fontFamily: 'DMSans_700Bold' },
  dateMonth: { ...typography.caption, color: colors.primary, fontFamily: 'DMSans_500Medium', marginTop: 1 },
  headerInfo: { flex: 1 },
  time: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  channel: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_400Regular', textTransform: 'capitalize', marginTop: 3 },
  section: { marginBottom: spacing.xxl },
  sectionTitle: { ...typography.label, color: colors.textMuted, fontFamily: 'DMSans_500Medium', marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  notesCard: { padding: spacing.lg },
  notesText: { ...typography.body, color: colors.text, fontFamily: 'DMSans_400Regular', lineHeight: 24 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle, gap: spacing.md },
  infoLabel: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular' },
  infoValue: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium', flex: 1, textAlign: 'right' },
  cancelBtn: { marginTop: spacing.lg, borderColor: colors.danger },
}))
