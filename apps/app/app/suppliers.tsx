import { useCallback, useEffect, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

interface Supplier {
  id: string
  name: string
  email: string
  phone: string | null
  contactPerson: string | null
  isActive: boolean
}

export default function SuppliersScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [contact, setContact] = useState('')

  const load = useCallback(async () => {
    if (!token) return setLoading(false)
    try {
      const data = await apiRequest<{ suppliers: Supplier[]; canManage: boolean }>('/api/mobile/pharmacy/suppliers', { token })
      setSuppliers(data.suppliers)
      setCanManage(data.canManage)
    } catch {
      setSuppliers([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const add = async () => {
    if (!token) return
    if (!name.trim() || !email.trim()) {
      Alert.alert('Missing info', 'Name and email are required.')
      return
    }
    setSaving(true)
    try {
      await apiRequest('/api/mobile/pharmacy/suppliers', { method: 'POST', token, body: { name, email, phone, contactPerson: contact } })
      setShowAdd(false)
      setName(''); setEmail(''); setPhone(''); setContact('')
      await load()
    } catch (err) {
      Alert.alert('Could not add supplier', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Suppliers</Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading suppliers…" />
      ) : (
        <FlatList
          data={suppliers}
          keyExtractor={(s) => s.id}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
          ListHeaderComponent={
            canManage ? (
              showAdd ? (
                <View style={styles.addCard}>
                  <Text style={styles.addTitle}>New supplier</Text>
                  <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.textMuted} />
                  <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.textMuted} />
                  <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="Phone (optional)" keyboardType="phone-pad" placeholderTextColor={colors.textMuted} />
                  <TextInput style={styles.input} value={contact} onChangeText={setContact} placeholder="Contact person (optional)" placeholderTextColor={colors.textMuted} />
                  <View style={styles.addActions}>
                    <Button label="Cancel" variant="ghost" onPress={() => setShowAdd(false)} style={{ flex: 1 }} />
                    <Button label="Save" onPress={add} loading={saving} style={{ flex: 1 }} />
                  </View>
                </View>
              ) : (
                <Button label="Add supplier" onPress={() => setShowAdd(true)} style={{ marginBottom: spacing.md }} />
              )
            ) : undefined
          }
          ListEmptyComponent={<EmptyState title="No suppliers" body="Add suppliers to raise purchase orders and receive stock." icon="business" />}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>{item.email}{item.phone ? ` · ${item.phone}` : ''}</Text>
              {item.contactPerson ? <Text style={styles.meta}>{item.contactPerson}</Text> : null}
            </View>
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
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  name: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  meta: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  addCard: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm, marginBottom: spacing.md },
  addTitle: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, color: colors.text, backgroundColor: colors.bgElevated, fontFamily: 'DMSans_400Regular' },
  addActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
})
