import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  createPharmacySupplier,
  fetchPharmacySuppliers,
  type PharmacySupplier,
} from '@/lib/api'
import { radii, spacing, tabBarHeight, typography, makeStyles, useTheme } from '@/lib/theme'

export default function SuppliersScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const insets = useSafeAreaInsets()
  const [suppliers, setSuppliers] = useState<PharmacySupplier[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [contactPerson, setContactPerson] = useState('')

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacySuppliers(token)
      setSuppliers(data.suppliers)
    } catch {
      setSuppliers([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!token) return
    if (!name.trim() || !email.trim()) {
      Alert.alert('Required', 'Name and email are required.')
      return
    }
    setSaving(true)
    try {
      await createPharmacySupplier(token, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        contactPerson: contactPerson.trim() || undefined,
      })
      setShowForm(false)
      setName('')
      setEmail('')
      setPhone('')
      setContactPerson('')
      await load()
    } catch (err) {
      Alert.alert(
        'Create failed',
        err instanceof ApiError ? err.message : 'Try again',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable style={styles.toolBtn} onPress={() => setShowForm(true)}>
          <Text style={styles.toolBtnText}>+ Add supplier</Text>
        </Pressable>
      </View>

      {loading ? (
        <LoadingBlock message="Loading suppliers…" />
      ) : (
        <FlatList
          data={suppliers}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                load()
              }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + tabBarHeight + spacing.lg },
          ]}
          ListEmptyComponent={
            <EmptyState
              title="No suppliers"
              body="Add a supplier to create purchase orders."
              icon="inbox"
            />
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>{item.email ?? '—'}</Text>
              {item.phone ? <Text style={styles.meta}>{item.phone}</Text> : null}
              {item.contactPerson ? (
                <Text style={styles.meta}>Contact: {item.contactPerson}</Text>
              ) : null}
              <Text style={styles.count}>
                {item.purchaseOrderCount ?? 0} purchase order
                {(item.purchaseOrderCount ?? 0) === 1 ? '' : 's'}
              </Text>
            </View>
          )}
        />
      )}

      <Modal visible={showForm} animationType="slide" presentationStyle="pageSheet">
        <KeyboardAvoidingView
          style={styles.modal}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.modalHeader, { paddingTop: insets.top + spacing.md }]}>
            <Text style={styles.modalTitle}>New supplier</Text>
            <Pressable onPress={() => setShowForm(false)}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.form}
            keyboardShouldPersistTaps="handled"
          >
            <TextField label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <TextField label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <TextField
              label="Contact person"
              value={contactPerson}
              onChangeText={setContactPerson}
            />
            <Button label="Save supplier" onPress={create} loading={saving} />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  toolbar: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  toolBtn: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignSelf: 'flex-start',
  },
  toolBtnText: {
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
  },
  list: { paddingHorizontal: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  name: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  meta: {
    ...typography.bodySm,
    color: colors.textSecondary,
    marginTop: 4,
    fontFamily: 'DMSans_400Regular',
  },
  count: {
    ...typography.label,
    color: colors.textMuted,
    marginTop: spacing.sm,
    fontFamily: 'DMSans_500Medium',
  },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  modalTitle: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold' },
  cancel: { color: colors.primary, fontFamily: 'DMSans_500Medium' },
  form: { padding: spacing.xl },
}))
