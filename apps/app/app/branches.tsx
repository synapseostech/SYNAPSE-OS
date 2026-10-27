import { useCallback, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type StoreType = 'main' | 'satellite' | 'dispensary' | 'warehouse'

interface Branch {
  id: string
  name: string
  storeType: string
  isActive: boolean
  isWarehouse: boolean
  district: string | null
  phone: string | null
  address: string | null
}

interface BranchesData {
  canManage: boolean
  branches: Branch[]
}

const TYPES: { value: StoreType; label: string }[] = [
  { value: 'satellite', label: 'Satellite' },
  { value: 'main', label: 'Main' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'dispensary', label: 'Dispensary' },
]

function typeLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
}

export default function BranchesScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const [data, setData] = useState<BranchesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [storeType, setStoreType] = useState<StoreType>('satellite')
  const [district, setDistrict] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await apiRequest<BranchesData>('/api/mobile/pharmacy/branches', { token })
      setData(result)
    } catch (err) {
      setData(null)
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include branch settings.'
          : 'Could not load branches.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const createBranch = async () => {
    if (!token) return
    setError(null)
    if (!name.trim()) {
      setError('Enter a branch name.')
      return
    }
    setSaving(true)
    try {
      await apiRequest('/api/mobile/pharmacy/branches', {
        method: 'POST',
        token,
        body: {
          name: name.trim(),
          storeType,
          district: district.trim() || null,
          phone: phone.trim() || null,
        },
      })
      setName('')
      setDistrict('')
      setPhone('')
      await load()
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Only settings managers can add branches.'
          : err instanceof ApiError
            ? err.message
            : 'Could not create the branch.',
      )
    } finally {
      setSaving(false)
    }
  }

  const setActive = async (branch: Branch, isActive: boolean) => {
    if (!token) return
    setError(null)
    setBusyId(branch.id)
    try {
      await apiRequest('/api/mobile/pharmacy/branches', {
        method: 'PATCH',
        token,
        body: { id: branch.id, isActive },
      })
      await load()
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Only settings managers can change branches.'
          : err instanceof ApiError
            ? err.message
            : 'Could not update the branch.',
      )
    } finally {
      setBusyId(null)
    }
  }

  const toggleActive = (branch: Branch) => {
    if (!branch.isActive) {
      void setActive(branch, true)
      return
    }
    Alert.alert(
      'Deactivate branch?',
      `${branch.name} stops taking stock and sales until it is reactivated. Past records are kept.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Deactivate', style: 'destructive', onPress: () => void setActive(branch, false) },
      ],
    )
  }

  return (
    <ScreenShell title="Branches" contentStyle={styles.content}>
      {loading ? (
        <LoadingBlock message="Loading branches…" />
      ) : !data ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>
            {error ?? 'Could not load branches.'}
          </Text>
        </Card>
      ) : (
        <>
          <Text style={[styles.intro, { color: colors.textSecondary }]}>
            Each site keeps its own stock, POS and staff. Head office still sees consolidated
            reports.
          </Text>

          {data.canManage ? (
            <>
              <SectionHeader title="Add a branch" />
              <Card>
                <View style={styles.form}>
                  <TextField
                    label="Branch name"
                    value={name}
                    onChangeText={setName}
                    placeholder="e.g. Ntinda branch"
                    maxLength={120}
                  />
                  <ChoiceChips
                    label="Site type"
                    options={TYPES}
                    value={storeType}
                    onChange={setStoreType}
                  />
                  <TextField
                    label="District"
                    value={district}
                    onChangeText={setDistrict}
                    placeholder="e.g. Kampala"
                    maxLength={80}
                  />
                  <TextField
                    label="Phone"
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="07…"
                    keyboardType="phone-pad"
                    maxLength={40}
                  />
                  {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
                  <Button label="Create branch" onPress={createBranch} loading={saving} />
                </View>
              </Card>
            </>
          ) : (
            <Text style={[styles.readonly, { color: colors.textMuted }]}>
              You have read-only access to branches. An admin can add or deactivate sites.
            </Text>
          )}

          <SectionHeader title={`Sites (${data.branches.length})`} style={styles.spacer} />

          {data.branches.length === 0 ? (
            <EmptyState
              icon="business"
              title="No branches yet"
              body="Create the first site to give staff a stock and POS location."
            />
          ) : (
            <View style={styles.list}>
              {data.branches.map((branch) => (
                <Card key={branch.id}>
                  <View style={styles.branchTop}>
                    <Text style={[styles.branchName, { color: colors.text }]} numberOfLines={1}>
                      {branch.name}
                    </Text>
                    <Text
                      style={[
                        styles.branchState,
                        { color: branch.isActive ? colors.success : colors.textMuted },
                      ]}
                    >
                      {branch.isActive ? 'Active' : 'Inactive'}
                    </Text>
                  </View>
                  <Text style={[styles.branchMeta, { color: colors.textMuted }]}>
                    {typeLabel(branch.storeType)}
                    {branch.isWarehouse ? ' · warehouse' : ''}
                    {branch.district ? ` · ${branch.district}` : ''}
                    {branch.phone ? ` · ${branch.phone}` : ''}
                  </Text>
                  {data.canManage ? (
                    <Button
                      label={branch.isActive ? 'Deactivate' : 'Reactivate'}
                      variant={branch.isActive ? 'danger' : 'ghost'}
                      onPress={() => toggleActive(branch)}
                      loading={busyId === branch.id}
                      style={styles.branchAction}
                    />
                  ) : null}
                </Card>
              ))}
            </View>
          )}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Renaming, addresses and store type can be changed in the web portal. Transfers and stock
            counts stay in the stock screens.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  intro: { ...typography.bodySm, lineHeight: 20 },
  readonly: { ...typography.caption, marginTop: spacing.sm },
  spacer: { marginTop: spacing.sm },
  form: { gap: spacing.sm },
  list: { gap: spacing.sm },
  branchTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  branchName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', flex: 1 },
  branchState: { ...typography.caption, fontFamily: 'DMSans_700Bold' },
  branchMeta: { ...typography.caption, marginTop: spacing.xs, textTransform: 'capitalize' },
  branchAction: { marginTop: spacing.md, height: 38 },
  message: { ...typography.bodySm },
  error: { ...typography.caption, textAlign: 'center' },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
