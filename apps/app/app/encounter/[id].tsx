import { useEffect, useState } from 'react'
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface EncounterDetail {
  encounterId: string
  status: string
  chiefComplaint: string | null
  clinicalStage: string | null
  createdAt: string
  patient: {
    id: string
    fullName: string
    mrn: string | null
    dateOfBirth: string | null
    sex: string | null
    bloodGroup: string | null
  } | null
  vitals: {
    temperature: number | null
    bpSystolic: number | null
    bpDiastolic: number | null
    pulse: number | null
    weight: number | null
    height: number | null
    spo2: number | null
  } | null
  providerName: string | null
}

const WEB_APP_URL = (
  (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
).replace(/\/$/, '')

export default function EncounterDetailScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const router = useRouter()
  const [encounter, setEncounter] = useState<EncounterDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id || !token) {
      setLoading(false)
      return
    }
    apiRequest<{ encounter: EncounterDetail }>(`/api/mobile/encounter/${id}`, { token })
      .then((data) => setEncounter(data.encounter))
      .catch(() => setError('Failed to load encounter'))
      .finally(() => setLoading(false))
  }, [id, token])

  if (loading) {
    return <View style={styles.center}><LoadingBlock message="Loading encounter…" /></View>
  }

  if (error || !encounter) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Encounter not found'}</Text>
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    )
  }

  const patient = encounter.patient
  const vitals = encounter.vitals

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={20} color={colors.primary} />
        <Text style={styles.backLabel}>Queue</Text>
      </Pressable>

      {patient ? (
        <View style={styles.header}>
          <Avatar label={patient.fullName[0]?.toUpperCase() ?? '?'} size={52} tone="neutral" />
          <View style={styles.headerInfo}>
            <Text style={styles.patientName}>{patient.fullName}</Text>
            <Text style={styles.patientMeta}>
              {[patient.mrn ? `MRN ${patient.mrn}` : null, patient.sex, patient.dateOfBirth ? `Age ${calcAge(patient.dateOfBirth)}` : null]
                .filter(Boolean).join(' · ')}
            </Text>
          </View>
          <StatusBadge status={encounter.status} />
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Encounter</Text>
        <View style={styles.card}>
          <InfoRow label="Time" value={formatTime(encounter.createdAt)} />
          {encounter.chiefComplaint ? (
            <InfoRow label="Chief complaint" value={encounter.chiefComplaint} />
          ) : null}
          {encounter.clinicalStage ? (
            <InfoRow label="Stage / Dx" value={encounter.clinicalStage} />
          ) : null}
          {encounter.providerName ? (
            <InfoRow label="Provider" value={encounter.providerName} />
          ) : null}
          {patient?.bloodGroup ? (
            <InfoRow label="Blood group" value={patient.bloodGroup} />
          ) : null}
        </View>
      </View>

      {vitals ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vitals</Text>
          <View style={styles.vitalsGrid}>
            <VitalCard
              label="BP"
              value={vitals.bpSystolic && vitals.bpDiastolic ? `${vitals.bpSystolic}/${vitals.bpDiastolic}` : '—'}
              unit="mmHg"
            />
            <VitalCard label="Pulse" value={vitals.pulse ? String(vitals.pulse) : '—'} unit="bpm" />
            <VitalCard label="Temp" value={vitals.temperature ? `${vitals.temperature}` : '—'} unit="°C" />
            <VitalCard label="SpO2" value={vitals.spo2 ? `${vitals.spo2}` : '—'} unit="%" />
            <VitalCard label="Weight" value={vitals.weight ? `${vitals.weight}` : '—'} unit="kg" />
            <VitalCard label="Height" value={vitals.height ? `${vitals.height}` : '—'} unit="cm" />
          </View>
        </View>
      ) : null}

      <Button
        label="Open full chart in web"
        onPress={() => Linking.openURL(`${WEB_APP_URL}/os/encounters/${id}`).catch(() => {})}
        style={styles.ctaBtn}
      />
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

function calcAge(dob: string) {
  return Math.floor((Date.now() - new Date(dob).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
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
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xxxl },
  headerInfo: { flex: 1 },
  patientName: { ...typography.title, color: colors.text, fontFamily: 'DMSans_700Bold', fontSize: 18 },
  patientMeta: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_400Regular', marginTop: 3 },
  section: { marginBottom: spacing.xxl },
  sectionTitle: {
    ...typography.label,
    color: colors.textMuted,
    fontFamily: 'DMSans_500Medium',
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.md,
  },
  infoLabel: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular' },
  infoValue: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium', flex: 1, textAlign: 'right' },
  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  vitalCard: {
    flex: 1,
    minWidth: '30%',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: 'center',
  },
  vitalLabel: { ...typography.label, color: colors.textMuted, fontFamily: 'DMSans_500Medium', marginBottom: 4 },
  vitalValue: { fontSize: 18, fontWeight: '700', color: colors.text, fontFamily: 'DMSans_700Bold' },
  vitalUnit: { color: colors.textMuted, fontSize: 10, fontFamily: 'DMSans_400Regular', marginTop: 2 },
  ctaBtn: { marginTop: spacing.md },
}))
