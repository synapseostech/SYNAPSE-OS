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
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme, type ThemeColors } from '@/lib/theme'

interface PatientDetail {
  id: string
  fullName: string
  mrn: string | null
  dateOfBirth: string | null
  sex: string | null
  phone: string | null
  address: string | null
  bloodGroup: string | null
  allergies: string[] | null
  createdAt: string
}

interface Encounter {
  id: string
  status: string
  chiefComplaint: string | null
  clinicalStage: string | null
  visitDate: string | null
  createdAt: string
}

interface Vitals {
  bpSystolic: number | null
  bpDiastolic: number | null
  heartRate: number | null
  temperatureC: number | null
  spo2: number | null
  recordedAt: string
}

const statusColors = (colors: ThemeColors): Record<string, string> => ({
  open: colors.primary,
  in_progress: colors.gold,
  completed: colors.success,
})

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  completed: 'Completed',
}

export default function PatientDetailScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const router = useRouter()
  const [patient, setPatient] = useState<PatientDetail | null>(null)
  const [encounters, setEncounters] = useState<Encounter[]>([])
  const [vitals, setVitals] = useState<Vitals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    apiRequest<{ patient: PatientDetail; encounters: Encounter[]; latestVitals: Vitals | null }>(
      `/api/mobile/patients/${id}`,
      { token }
    )
      .then(data => {
        setPatient(data.patient)
        setEncounters(data.encounters)
        setVitals(data.latestVitals)
      })
      .catch(() => setError('Failed to load patient'))
      .finally(() => setLoading(false))
  }, [id, token])

  if (loading) {
    return (
      <View style={styles.centerScreen}>
        <LoadingBlock message="Loading patient…" />
      </View>
    )
  }

  if (error || !patient) {
    return (
      <View style={styles.centerScreen}>
        <Text style={styles.errorText}>{error ?? 'Patient not found'}</Text>
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    )
  }

  const age = patient.dateOfBirth ? calcAge(patient.dateOfBirth) : null

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Back */}
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={20} color={colors.primary} />
        <Text style={styles.backLabel}>Patients</Text>
      </Pressable>

      <View style={styles.header}>
        <Avatar label={patient.fullName[0]?.toUpperCase() ?? '?'} size={56} tone="neutral" />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerName}>{patient.fullName}</Text>
          <Text style={styles.headerSub}>
            {[patient.mrn ? `MRN ${patient.mrn}` : null, patient.sex, age ? `Age ${age}` : null]
              .filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Demographics" />
        <Card padded={false}>
          <InfoRow label="Date of Birth" value={patient.dateOfBirth ?? '—'} />
          <DividerLine />
          <InfoRow label="Sex" value={patient.sex ?? '—'} />
          <DividerLine />
          <InfoRow label="Blood Group" value={patient.bloodGroup ?? '—'} />
          <DividerLine />
          <InfoRow label="Phone" value={patient.phone ?? '—'} />
          {patient.allergies?.length ? (
            <>
              <DividerLine />
              <InfoRow label="Allergies" value={patient.allergies.join(', ')} />
            </>
          ) : null}
        </Card>
      </View>

      {vitals ? (
        <View style={styles.section}>
          <SectionHeader title="Latest vitals" />
          <View style={styles.vitalsGrid}>
            <VitalCard label="BP" value={vitals.bpSystolic && vitals.bpDiastolic ? `${vitals.bpSystolic}/${vitals.bpDiastolic}` : '—'} unit="mmHg" />
            <VitalCard label="HR" value={vitals.heartRate ? String(vitals.heartRate) : '—'} unit="bpm" />
            <VitalCard label="Temp" value={vitals.temperatureC ? `${vitals.temperatureC}` : '—'} unit="°C" />
            <VitalCard label="SpO2" value={vitals.spo2 ? `${vitals.spo2}` : '—'} unit="%" />
          </View>
          <Text style={styles.vitalsTime}>Recorded {formatDate(vitals.recordedAt)}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title="Recent encounters" />
        {encounters.length === 0 ? (
          <Text style={styles.noData}>No encounters on record</Text>
        ) : (
          encounters.map(enc => (
            <View key={enc.id} style={styles.encounterCard}>
              <View style={styles.encounterHeader}>
                <Text style={styles.encounterDate}>{formatDate(enc.createdAt)}</Text>
                <View style={[styles.statusPill, { borderColor: statusColors(colors)[enc.status] ?? '#52525B' }]}>
                  <Text style={[styles.statusText, { color: statusColors(colors)[enc.status] ?? '#52525B' }]}>
                    {STATUS_LABELS[enc.status] ?? enc.status}
                  </Text>
                </View>
              </View>
              {enc.chiefComplaint ? (
                <Text style={styles.encounterComplaint}>{enc.chiefComplaint}</Text>
              ) : null}
              {enc.clinicalStage ? (
                <Text style={styles.encounterDx}>Dx: {enc.clinicalStage}</Text>
              ) : null}
            </View>
          ))
        )}
      </View>
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

function DividerLine() {
  const { colors } = useTheme()
  return <View style={{ height: 1, backgroundColor: colors.borderSubtle }} />
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

function calcAge(dob: string) {
  const diff = Date.now() - new Date(dob).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25))
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  centerScreen: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  errorText: {
    ...typography.body,
    color: colors.error,
    fontFamily: 'DMSans_400Regular',
    textAlign: 'center',
  },

  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl, gap: 4 },
  backLabel: {
    ...typography.bodyMedium,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },

  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.xxxl },
  headerName: {
    ...typography.title,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
  },
  headerSub: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 3,
  },

  section: { marginBottom: spacing.xxxl },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg },
  infoLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  infoValue: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    textAlign: 'right',
    flex: 1,
    marginLeft: spacing.lg,
  },

  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  vitalCard: {
    flex: 1,
    minWidth: '44%',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
  },
  vitalLabel: {
    ...typography.label,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
    marginBottom: 6,
  },
  vitalValue: {
    ...typography.stat,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
  },
  vitalUnit: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  vitalsTime: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
    textAlign: 'right',
  },

  encounterCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  encounterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  encounterDate: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  statusPill: { borderRadius: radii.full, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 10, fontWeight: '600', fontFamily: 'DMSans_700Bold' },
  encounterComplaint: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    marginBottom: 4,
  },
  encounterDx: {
    ...typography.caption,
    color: colors.success,
    fontFamily: 'DMSans_400Regular',
  },

  noData: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
}))
