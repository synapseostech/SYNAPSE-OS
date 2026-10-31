import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { colors, radii, spacing, typography, TONE_COLORS } from '@/lib/theme'

interface StaffUser {
  id: string
  name: string
  email: string
  role: string
  isActive: boolean
}

const ROLES = ['pharmacy_staff', 'pharmacy_cashier', 'pharmacist', 'pharmacy_admin']

export default function UsersScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [users, setUsers] = useState<StaffUser[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [inviting, setInviting] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('pharmacy_staff')

  const load = useCallback(async () => {
    if (!token) return setLoading(false)
    try {
      const data = await apiRequest<{ users: StaffUser[]; canManage: boolean }>('/api/mobile/pharmacy/users', { token })
      setUsers(data.users)
      setCanManage(data.canManage)
    } catch {
      setUsers([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const invite = async () => {
    if (!token) return
    if (!name.trim() || !email.trim()) {
      Alert.alert('Missing info', 'Name and email are required.')
      return
    }
    setInviting(true)
    try {
      const res = await apiRequest<{ inviteSent?: boolean; emailSent?: boolean }>('/api/mobile/pharmacy/users', {
        method: 'POST',
        token,
        body: { name, email, role },
      })
      setShowInvite(false)
      setName('')
      setEmail('')
      setRole('pharmacy_staff')
      await load()
      Alert.alert(
        'User created',
        res.inviteSent
          ? 'A secure set-password link was emailed to them (valid 72 hours).'
          : 'The account was created but the invite email could not be sent. Use "Reset password" to send a new link.',
      )
    } catch (err) {
      Alert.alert('Invite failed', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setInviting(false)
    }
  }

  const patch = async (id: string, body: Record<string, unknown>, successMsg?: string) => {
    if (!token) return
    try {
      const res = await apiRequest<{ resetLinkSent?: boolean }>('/api/mobile/pharmacy/users', {
        method: 'PATCH',
        token,
        body: { id, ...body },
      })
      await load()
      if (res.resetLinkSent !== undefined) {
        Alert.alert(
          'Password reset',
          res.resetLinkSent
            ? 'Their old password and sessions were revoked. A secure set-password link was emailed.'
            : 'Their old password was revoked, but the email could not be sent. Try again.',
        )
      } else if (successMsg) {
        Alert.alert('Done', successMsg)
      }
    } catch (err) {
      Alert.alert('Update failed', err instanceof ApiError ? err.message : 'Try again.')
    }
  }

  const openActions = (u: StaffUser) => {
    if (!canManage) return
    Alert.alert(u.name || u.email, 'Manage staff member', [
      { text: u.isActive ? 'Disable' : 'Reactivate', onPress: () => patch(u.id, { isActive: !u.isActive }, u.isActive ? 'User disabled' : 'User reactivated') },
      { text: 'Reset password', onPress: () => patch(u.id, { resetPassword: true }) },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Staff & users</Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading staff…" />
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
          ListHeaderComponent={
            canManage ? (
              showInvite ? (
                <View style={styles.inviteCard}>
                  <Text style={styles.inviteTitle}>Invite staff</Text>
                  <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor={colors.textMuted} />
                  <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.textMuted} />
                  <View style={styles.roleChips}>
                    {ROLES.map((r) => (
                      <Pressable key={r} onPress={() => setRole(r)} style={[styles.chip, role === r && styles.chipActive]}>
                        <Text style={[styles.chipText, role === r && styles.chipTextActive]}>{r.replace('pharmacy_', '')}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.inviteActions}>
                    <Button label="Cancel" variant="ghost" onPress={() => setShowInvite(false)} style={{ flex: 1 }} />
                    <Button label="Create" onPress={invite} loading={inviting} style={{ flex: 1 }} />
                  </View>
                </View>
              ) : (
                <Button label="Invite staff" onPress={() => setShowInvite(true)} style={{ marginBottom: spacing.md }} />
              )
            ) : undefined
          }
          ListEmptyComponent={<EmptyState title="No staff yet" body="Invite your team to give them access." icon="people" />}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => openActions(item)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name || item.email}</Text>
                <Text style={styles.email}>{item.email}</Text>
                <Text style={styles.role}>{item.role?.replace('pharmacy_', '') ?? 'staff'}</Text>
              </View>
              <Text style={[styles.badge, { color: item.isActive ? TONE_COLORS.green : colors.textMuted }]}>
                {item.isActive ? 'Active' : 'Disabled'}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.lg, gap: spacing.sm },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.md },
  name: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  email: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  role: { ...typography.caption, color: colors.textSecondary, marginTop: 2, textTransform: 'capitalize' },
  badge: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  inviteCard: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm, marginBottom: spacing.md },
  inviteTitle: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, color: colors.text, backgroundColor: colors.bgElevated, fontFamily: 'DMSans_400Regular' },
  roleChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { paddingVertical: spacing.xs, paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...typography.caption, color: colors.textSecondary, textTransform: 'capitalize' },
  chipTextActive: { color: colors.primaryForeground, fontFamily: 'DMSans_700Bold' },
  inviteActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
})
