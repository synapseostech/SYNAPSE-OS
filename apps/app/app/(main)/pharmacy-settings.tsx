import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchPharmacySettings,
  patchPharmacySettings,
} from '@/lib/api'
import { radii, spacing, tabBarHeight, typography, makeStyles } from '@/lib/theme'

export default function PharmacySettingsScreen() {
  const styles = useStyles()
  const { token, user } = useAuth()
  const insets = useSafeAreaInsets()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pharmacyName, setPharmacyName] = useState('')
  const [receiptHeader, setReceiptHeader] = useState('')
  const [receiptFooter, setReceiptFooter] = useState('')
  const [currency, setCurrency] = useState('UGX')
  const canEdit = Boolean(user?.isAdmin) ||
    user?.role === 'pharmacy_admin' ||
    user?.role === 'pharmacy_ceo' ||
    user?.role === 'pharmacist'

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacySettings(token)
      setPharmacyName(data.settings.pharmacyName ?? '')
      setReceiptHeader(data.settings.receiptHeader ?? '')
      setReceiptFooter(data.settings.receiptFooter ?? '')
      setCurrency(data.settings.currency ?? 'UGX')
    } catch {
      // keep blanks
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    if (!token) return
    setSaving(true)
    try {
      await patchPharmacySettings(token, {
        pharmacyName: pharmacyName.trim(),
        receiptHeader,
        receiptFooter,
      })
      Alert.alert('Saved', 'Pharmacy settings updated.')
    } catch (err) {
      Alert.alert('Save failed', err instanceof ApiError ? err.message : 'Try again')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <View style={styles.root}>
        <LoadingBlock message="Loading settings…" />
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{
        padding: spacing.xl,
        paddingBottom: insets.bottom + tabBarHeight + spacing.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.card}>
        <Text style={styles.meta}>Currency: {currency}</Text>
        <TextField
          label="Pharmacy name"
          value={pharmacyName}
          onChangeText={setPharmacyName}
          editable={canEdit}
        />
        <TextField
          label="Receipt header"
          value={receiptHeader}
          onChangeText={setReceiptHeader}
          editable={canEdit}
          multiline
          style={{ minHeight: 80, textAlignVertical: 'top' }}
        />
        <TextField
          label="Receipt footer"
          value={receiptFooter}
          onChangeText={setReceiptFooter}
          editable={canEdit}
          multiline
          style={{ minHeight: 80, textAlignVertical: 'top' }}
        />
        {canEdit ? (
          <Button label="Save changes" onPress={save} loading={saving} />
        ) : (
          <Text style={styles.hint}>View only — ask an admin to edit settings.</Text>
        )}
      </View>
    </ScrollView>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  meta: {
    ...typography.bodySm,
    color: colors.textMuted,
    marginBottom: spacing.lg,
    fontFamily: 'DMSans_400Regular',
  },
  hint: {
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
}))
