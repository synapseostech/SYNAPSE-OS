import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface Patient {
  id: string
  fullName: string
  mrn: string | null
  dateOfBirth: string | null
  sex: string | null
  createdAt: string
}

export default function PatientsScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [patients, setPatients] = useState<Patient[]>([])
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback(async (q: string) => {
    if (!token) {
      setLoading(false)
      return
    }
    setSearching(true)
    try {
      const path = q ? `/api/mobile/patients?q=${encodeURIComponent(q)}` : '/api/mobile/patients'
      const data = await apiRequest<{ patients: Patient[] }>(path, { token })
      setPatients(data.patients)
    } catch {
      setPatients([])
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [token])

  useEffect(() => { search('') }, [search])

  const handleQuery = (text: string) => {
    setQuery(text)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => search(text.trim()), 400)
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={handleQuery}
          placeholder="Search by name or MRN"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          returnKeyType="search"
          autoCapitalize="none"
        />
        {searching ? <ActivityIndicator color={colors.primary} size="small" /> : null}
      </View>

      {loading ? (
        <LoadingBlock message="Loading patients…" />
      ) : (
        <FlatList
          data={patients}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <EmptyState
              title={query ? 'No matches' : 'No patients yet'}
              body={
                query
                  ? 'Try a different name or MRN.'
                  : 'Registered patients will appear here.'
              }
              icon="search"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/patient/${item.id}` as never)}
            >
              <Avatar
                label={item.fullName[0]?.toUpperCase() ?? '?'}
                size={44}
                tone="neutral"
              />
              <View style={styles.cardBody}>
                <Text style={styles.name}>{item.fullName}</Text>
                <View style={styles.meta}>
                  {item.mrn ? <Text style={styles.metaText}>MRN {item.mrn}</Text> : null}
                  {item.sex ? <Text style={styles.dot}>·</Text> : null}
                  {item.sex ? <Text style={styles.metaText}>{item.sex}</Text> : null}
                  {item.dateOfBirth ? <Text style={styles.dot}>·</Text> : null}
                  {item.dateOfBirth ? (
                    <Text style={styles.metaText}>DOB {item.dateOfBirth}</Text>
                  ) : null}
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontFamily: 'DMSans_400Regular',
    paddingVertical: 13,
  },
  listContent: { paddingBottom: spacing.xxxl },
  separator: { height: 1, backgroundColor: colors.borderSubtle, marginHorizontal: spacing.lg },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    gap: spacing.md,
  },
  cardPressed: { backgroundColor: colors.surfaceHover },
  cardBody: { flex: 1 },
  name: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  meta: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 3, gap: 2 },
  metaText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
  },
  dot: { color: colors.textMuted, fontSize: 12 },
}))
