import { useEffect, useState } from 'react'
import {
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
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface RecordDetail {
  id: string
  type: 'encounter' | 'lab' | 'profile'
  title: string
  subtitle: string | null
  date: string
  meta: string | null
  notes: string | null
  diagnoses: string[]
  vitals: {
    temperature: number | null
    bpSystolic: number | null
    bpDiastolic: number | null
    pulse: number | null
    weight: number | null
    spo2: number | null
  } | null
  providerName: string | null
  facilityName: string | null
}

const TYPE_LABELS: Record<string, string> = {
  encounter: 'Visit',
  lab: 'Lab Result',
  profile: 'Profile Update',
}

export default function RecordDetailScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const router = useRouter()
  const [record, setRecord] = useState<RecordDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id || !token) { setLoading(false); return }
    apiRequest<{ record: RecordDetail }>(`/api/mobile/records/${id}`, { token })
      .then((data) => setRecord(data.record))
      .catch(() => setError('Failed to load record'))
      .finally(() => setLoading(false))
  }, [id, token])

  if (loading) {
    return <View style={styles.center}><LoadingBlock message="Loading record…" /></View>
  }

  if (error || !record) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Record not found'}</Text>
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={20} color={colors.primary} />
        <Text style={styles.backLabel}>Records</Text>
      </Pressable>

      <View style={styles.typePill}>
        <Text style={styles.typeText}>{TYPE_LABELS[record.type] ?? record.type}</Text>
      </View>
      <Text style={styles.title}>{record.title}</Text>
      <Text style={styles.date}>{formatDate(record.date)}</Text>
      {record.subtitle ? <Text style={styles.subtitle}>{record.subtitle}</Text> : null}

      {(record.providerName || record.facilityName) ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Details</Text>
          <View style={styles.card}>
            {record.providerName ? <InfoRow label="Provider" value={record.providerName} /> : null}
            {record.facilityName ? <InfoRow label="Facility" value={record.facilityName} /> : null}
            {record.meta ? <InfoRow label="Type" value={record.meta} /> : null}
          </View>
        </View>
      ) : null}

      {record.diagnoses.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Diagnoses</Text>
          <View style={styles.card}>
            {record.diagnoses.map((dx, i) => (
              <View key={i} style={styles.dxRow}>
                <View style={styles.dxDot} />
                <Text style={styles.dxText}>{dx}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {record.vitals ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vitals</Text>
          <View style={styles.vitalsGrid}>
            <VitalCard label="BP" value={record.vitals.bpSystolic && record.vitals.bpDiastolic ? `${record.vitals.bpSystolic}/${record.vitals.bpDiastolic}` : '—'} unit="mmHg" />
            <VitalCard label="Pulse" value={record.vitals.pulse ? String(record.vitals.pulse) : '—'} unit="bpm" />
            <VitalCard label="Temp" value={record.vitals.temperature ? `${record.vitals.temperature}` : '—'} unit="°C" />
            <VitalCard label="SpO2" value={record.vitals.spo2 ? `${record.vitals.spo2}` : '—'} unit="%" />
            <VitalCard label="Weight" value={record.vitals.weight ? `${record.vitals.weight}` : '—'} unit="kg" />
          </View>
        </View>
      ) : null}

      {record.notes ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <View style={[styles.card, styles.notesCard]}>
            <Text style={styles.notesText}>{record.notes}</Text>
          </View>
        </View>
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

function VitalCard({ label, value, unit }: { label: string; value: string; unit: string }) {
  const styles = useStyles()
  return (
    <View style={styles.vitalCard}>
      <Text style={styles.vitalLabel}>{label}</Text>
      <Text style={styles.vitalValue}>{value}</Text>
      <Text style={styles.vitalUnit}>{unit}</Text>
    </View>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  center: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl, gap: spacing.lg },
  errorText: { ...typography.body, color: colors.error, fontFamily: 'DMSans_400Regular', textAlign: 'center' },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl, gap: 4 },
  backLabel: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_500Medium' },
  typePill: { alignSelf: 'flex-start', backgroundColor: colors.tealSoft, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3, marginBottom: spacing.sm },
  typeText: { fontSize: 10, fontWeight: '600', color: colors.teal, fontFamily: 'DMSans_500Medium', textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold', marginBottom: spacing.xs },
  date: { ...typography.caption, color: colors.textMuted, fontFamily: 'DMSans_400Regular', marginBottom: spacing.sm },
  subtitle: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular', marginBottom: spacing.lg },
  section: { marginTop: spacing.xxl },
  sectionTitle: { ...typography.label, color: colors.textMuted, fontFamily: 'DMSans_500Medium', marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  notesCard: { padding: spacing.lg },
  notesText: { ...typography.body, color: colors.text, fontFamily: 'DMSans_400Regular', lineHeight: 24 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle, gap: spacing.md },
  infoLabel: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular' },
  infoValue: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium', flex: 1, textAlign: 'right' },
  dxRow: { flexDirection: 'row', alignItems: 'flex-start', padding: spacing.lg, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  dxDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.teal, marginTop: 6 },
  dxText: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_400Regular', flex: 1 },
  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  vitalCard: { flex: 1, minWidth: '30%', backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, alignItems: 'center' },
  vitalLabel: { ...typography.label, color: colors.textMuted, fontFamily: 'DMSans_500Medium', marginBottom: 4 },
  vitalValue: { fontSize: 18, fontWeight: '700', color: colors.text, fontFamily: 'DMSans_700Bold' },
  vitalUnit: { color: colors.textMuted, fontSize: 10, fontFamily: 'DMSans_400Regular', marginTop: 2 },
}))
