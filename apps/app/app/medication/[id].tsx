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

interface MedicationDetail {
  id: string
  name: string
  dose: string | null
  frequency: string | null
  notes: string | null
  source: string
  prescribingProvider: string | null
  prescribingEncounterId: string | null
  startDate: string | null
  endDate: string | null
  refillsRemaining: number | null
  indication: string | null
}

export default function MedicationDetailScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const router = useRouter()
  const [med, setMed] = useState<MedicationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id || !token) { setLoading(false); return }
    apiRequest<{ medication: MedicationDetail }>(`/api/mobile/medications/${id}`, { token })
      .then((data) => setMed(data.medication))
      .catch(() => setError('Failed to load medication'))
      .finally(() => setLoading(false))
  }, [id, token])

  if (loading) {
    return <View style={styles.center}><LoadingBlock message="Loading medication…" /></View>
  }

  if (error || !med) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Medication not found'}</Text>
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={20} color={colors.primary} />
        <Text style={styles.backLabel}>Medications</Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <Text style={styles.iconLetter}>{med.name[0]?.toUpperCase() ?? 'M'}</Text>
        </View>
        <View style={styles.headerInfo}>
          <Text style={styles.name}>{med.name}</Text>
          {(med.dose || med.frequency) ? (
            <Text style={styles.schedule}>
              {[med.dose, med.frequency].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Prescription</Text>
        <View style={styles.card}>
          {med.prescribingProvider ? <InfoRow label="Prescribed by" value={med.prescribingProvider} /> : null}
          {med.indication ? <InfoRow label="Indication" value={med.indication} /> : null}
          {med.startDate ? <InfoRow label="Start date" value={formatDate(med.startDate)} /> : null}
          {med.endDate ? <InfoRow label="End date" value={formatDate(med.endDate)} /> : null}
          {med.refillsRemaining !== null ? (
            <InfoRow label="Refills remaining" value={String(med.refillsRemaining)} />
          ) : null}
          <InfoRow label="Source" value={med.source} />
        </View>
      </View>

      {med.notes ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Instructions</Text>
          <View style={[styles.card, styles.notesCard]}>
            <Text style={styles.notesText}>{med.notes}</Text>
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

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  center: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl, gap: spacing.lg },
  errorText: { ...typography.body, color: colors.error, fontFamily: 'DMSans_400Regular', textAlign: 'center' },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl, gap: 4 },
  backLabel: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_500Medium' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.xxxl },
  iconWrap: { width: 56, height: 56, borderRadius: radii.lg, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  iconLetter: { fontSize: 24, fontWeight: '700', color: colors.primary, fontFamily: 'DMSans_700Bold' },
  headerInfo: { flex: 1 },
  name: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  schedule: { ...typography.bodySm, color: colors.teal, fontFamily: 'DMSans_500Medium', marginTop: 4 },
  section: { marginBottom: spacing.xxl },
  sectionTitle: { ...typography.label, color: colors.textMuted, fontFamily: 'DMSans_500Medium', marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  notesCard: { padding: spacing.lg },
  notesText: { ...typography.body, color: colors.text, fontFamily: 'DMSans_400Regular', lineHeight: 24 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle, gap: spacing.md },
  infoLabel: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular' },
  infoValue: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium', flex: 1, textAlign: 'right' },
}))
