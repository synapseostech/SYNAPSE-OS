import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { Ionicons } from '@expo/vector-icons'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Card, Divider } from '@/components/ui/Card'
import { WorkspaceHeader } from '@/components/WorkspaceHeader'
import { useAuth } from '@/lib/auth'
import { dashboardKindForRole, formatRole } from '@/lib/roles'
import {
  spacing,
  tabBarHeight,
  typography,
  useTheme,
  type ThemePreference,
} from '@/lib/theme'

const WEB_APP_URL = (
  (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
).replace(/\/$/, '')

const PHARM_PORTAL = 'https://pharm.synapseos.tech/portal'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

type NavItem = {
  label: string
  subtitle?: string
  icon: IoniconName
  route?: string
  onPress?: () => void
}

export default function ProfileScreen() {
  const { user, logout } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { colors, preference, setPreference, scheme } = useTheme()
  const initial = (user?.fullName ?? user?.email ?? '?')[0]?.toUpperCase() ?? '?'
  const kind = dashboardKindForRole(user?.role)

  const handleLogout = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await logout()
          router.replace('/(auth)/login')
        },
      },
    ])
  }

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => {})
  }

  const openWebPortal = () => {
    if (kind === 'pharmacy') {
      openUrl(`${PHARM_PORTAL}/dashboard`)
      return
    }
    const path =
      kind === 'patient'
        ? '/health/dashboard'
        : user?.role === 'platform_admin'
          ? '/platform'
          : '/login'
    openUrl(`${WEB_APP_URL}${path}`)
  }

  const go = (route: string) => router.push(route as never)

  const salesItems: NavItem[] = [
    { label: 'Point of sale', subtitle: 'Complete a sale', icon: 'cart-outline', route: '/pos' },
    { label: 'Till / cashier session', subtitle: 'Open, count, and close', icon: 'wallet-outline', route: '/till' },
    { label: 'Sync status', subtitle: 'Pending, failed, needs review', icon: 'cloud-upload-outline', route: '/sync-status' },
    { label: 'Sales history', subtitle: 'Receipts & lookups', icon: 'cash-outline', route: '/(main)/sales' },
    { label: 'Transactions', subtitle: 'Counter & order history', icon: 'receipt-outline', route: '/transactions' },
    { label: 'Refunds', subtitle: 'Reverse a sale', icon: 'return-down-back-outline', route: '/refunds' },
    { label: 'Reports', subtitle: 'Sales & inventory', icon: 'bar-chart-outline', route: '/reports' },
  ]

  const inventoryItems: NavItem[] = [
    { label: 'Inventory', subtitle: 'Stock on hand', icon: 'cube-outline', route: '/(main)/stock' },
    { label: 'Receive stock (GRN)', subtitle: 'Batch + expiry', icon: 'download-outline', route: '/receive-stock' },
    { label: 'Stock transfers', subtitle: 'Ship and receive between stores', icon: 'swap-horizontal-outline', route: '/transfers' },
    { label: 'Stock import', subtitle: 'CSV / Excel', icon: 'cloud-upload-outline', route: '/stock-import' },
    { label: 'Tally import', subtitle: 'Full accounting cut-over', icon: 'document-attach-outline', route: '/tally-import' },
    { label: 'Import assistant', subtitle: 'Migration history', icon: 'cloud-done-outline', route: '/import-assistant' },
    { label: 'Barcode lookup', subtitle: 'Scan or type', icon: 'barcode-outline', route: '/barcode-scan' },
  ]

  const purchasingItems: NavItem[] = [
    { label: 'Purchases', subtitle: 'Walk-in receive + history', icon: 'cart-outline', route: '/(main)/purchases' },
    { label: 'Orders', subtitle: 'Customer / counter orders', icon: 'bag-handle-outline', route: '/(main)/orders' },
    { label: 'Purchase orders', subtitle: 'Supplier POs', icon: 'clipboard-outline', route: '/(main)/purchase-orders' },
    { label: 'Suppliers', subtitle: 'Vendor directory', icon: 'business-outline', route: '/suppliers' },
  ]

  const financeItems: NavItem[] = [
    { label: 'Customers', subtitle: 'Directory & accounts', icon: 'people-circle-outline', route: '/customers' },
    { label: 'Credit ledger', subtitle: 'Balances & repayments', icon: 'book-outline', route: '/credit-ledger' },
    { label: 'Accounting', subtitle: 'Trial balance & journals', icon: 'calculator-outline', route: '/accounting' },
  ]

  const adminItems: NavItem[] = [
    { label: 'Staff & users', subtitle: 'Roles & temp passwords', icon: 'people-outline', route: '/users' },
    { label: 'Pharmacy settings', subtitle: 'Receipt & printer', icon: 'settings-outline', route: '/settings' },
    { label: 'Branches', subtitle: 'Sites & satellites', icon: 'business-outline', route: '/branches' },
    { label: 'Activity log', subtitle: 'Audit trail', icon: 'list-outline', route: '/activity-log' },
    { label: 'Billing & subscription', subtitle: 'Plan status', icon: 'card-outline', route: '/billing' },
    {
      label: 'Open web portal',
      subtitle: 'Full desktop workspace',
      icon: 'globe-outline',
      onPress: openWebPortal,
    },
  ]

  const themeOptions: Array<{ key: ThemePreference; label: string }> = [
    { key: 'system', label: 'System' },
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
  ]

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.bg }]}
      contentContainerStyle={{
        padding: spacing.xl,
        paddingBottom: insets.bottom + tabBarHeight + spacing.lg,
      }}
      showsVerticalScrollIndicator={false}
    >
      <WorkspaceHeader
        user={user}
        subtitle={kind === 'pharmacy' ? 'Pharmacy workspace' : 'Account & workspace'}
      />

      <View style={styles.profileRow}>
        <Avatar label={initial} size={64} />
        <View style={styles.profileCopy}>
          <Text style={[styles.name, { color: colors.text }]}>{user?.fullName ?? 'Unknown user'}</Text>
          <Text style={[styles.email, { color: colors.textSecondary }]}>{user?.email}</Text>
        </View>
      </View>

      <Card padded={false}>
        <InfoRow label="Role" value={formatRole(user?.role ?? '')} />
        <Divider />
        <InfoRow label="Workspace" value={user?.tenantName || (kind === 'patient' ? 'Personal Health' : '—')} />
        <Divider />
        <InfoRow label="Synapse ID" value={user?.synapseId ?? '—'} mono />
      </Card>

      {kind === 'pharmacy' ? (
        <>
          <NavSection title="Sales & POS" items={salesItems} onNavigate={go} />
          <NavSection title="Inventory" items={inventoryItems} onNavigate={go} />
          <NavSection title="Purchasing & orders" items={purchasingItems} onNavigate={go} />
          <NavSection title="Customers & finance" items={financeItems} onNavigate={go} />
          <NavSection title="Admin" items={adminItems} onNavigate={go} />
        </>
      ) : (
        <View style={styles.actions}>
          <Button label="Open web portal" onPress={openWebPortal} variant="ghost" />
        </View>
      )}

      <Text style={[styles.sectionTitle, { color: colors.primary }]}>Appearance</Text>
      <Card padded={false}>
        <View style={styles.themeRow}>
          {themeOptions.map((opt) => {
            const active = preference === opt.key
            return (
              <Pressable
                key={opt.key}
                onPress={() => setPreference(opt.key)}
                style={[
                  styles.themeChip,
                  {
                    borderColor: active ? colors.primary : colors.border,
                    backgroundColor: active ? colors.primarySoft : colors.bgElevated,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.themeChipText,
                    { color: active ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
        <Text style={[styles.themeHint, { color: colors.textMuted }]}>
          Using {scheme} mode{preference === 'system' ? ' (follows device)' : ''}
        </Text>
      </Card>

      <Text style={[styles.sectionTitle, { color: colors.primary }]}>Account</Text>
      <View style={styles.actions}>
        <Button
          label="Change password"
          onPress={() => router.push('/change-password' as never)}
          variant="ghost"
        />
        <Button label="Sign out" onPress={handleLogout} variant="danger" />
      </View>

      <View style={styles.footer}>
        <Ionicons name="shield-checkmark-outline" size={14} color={colors.textMuted} />
        <Text style={[styles.version, { color: colors.textMuted }]}>
          Synapse Health Technologies · Secure session
        </Text>
      </View>
    </ScrollView>
  )
}

function NavSection({
  title,
  items,
  onNavigate,
}: {
  title: string
  items: NavItem[]
  onNavigate: (route: string) => void
}) {
  const { colors } = useTheme()
  return (
    <View style={styles.sectionWrap}>
      <Text style={[styles.sectionTitle, { color: colors.primary }]}>{title}</Text>
      <Card padded={false}>
        {items.map((item, idx) => (
          <View key={item.label}>
            {idx > 0 ? <Divider /> : null}
            <Pressable
              onPress={() => (item.onPress ? item.onPress() : item.route ? onNavigate(item.route) : undefined)}
              style={({ pressed }) => [styles.navRow, pressed && { opacity: 0.85 }]}
            >
              <View style={[styles.navIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name={item.icon} size={18} color={colors.primary} />
              </View>
              <View style={styles.navCopy}>
                <Text style={[styles.navLabel, { color: colors.text }]}>{item.label}</Text>
                {item.subtitle ? (
                  <Text style={[styles.navSub, { color: colors.textMuted }]}>{item.subtitle}</Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </View>
        ))}
      </Card>
    </View>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          { color: colors.text },
          mono && { fontFamily: 'IBMPlexMono_500Medium', fontSize: 12 },
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginBottom: spacing.xl,
    marginTop: spacing.sm,
  },
  profileCopy: { flex: 1 },
  name: {
    ...typography.h2,
    fontFamily: 'DMSans_700Bold',
  },
  email: {
    ...typography.bodySm,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
  sectionWrap: { marginTop: spacing.lg },
  sectionTitle: {
    ...typography.bodyMedium,
    fontFamily: 'DMSans_700Bold',
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  navIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navCopy: { flex: 1 },
  navLabel: {
    ...typography.bodyMedium,
    fontFamily: 'DMSans_500Medium',
  },
  navSub: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  rowLabel: {
    ...typography.body,
    fontFamily: 'DMSans_400Regular',
  },
  rowValue: {
    ...typography.bodyMedium,
    fontFamily: 'DMSans_500Medium',
    textAlign: 'right',
    flex: 1,
  },
  themeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  themeChip: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  themeChipText: {
    ...typography.caption,
    fontFamily: 'DMSans_700Bold',
  },
  themeHint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.xxl,
  },
  version: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
  },
})
