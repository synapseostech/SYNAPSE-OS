import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '@/lib/auth'
import { dashboardKindForRole } from '@/lib/roles'
import { isTabVisible } from '@/lib/navigation'
import { tabBarHeight, useTheme } from '@/lib/theme'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

function TabIcon({ name, focused }: { name: IoniconsName; focused: boolean }) {
  const { colors } = useTheme()
  return (
    <Ionicons name={name} size={22} color={focused ? colors.primary : colors.textMuted} />
  )
}

function tabHref(role: string | undefined, tab: Parameters<typeof isTabVisible>[1]) {
  return isTabVisible(role, tab) ? undefined : null
}

export default function MainLayout() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const role = user?.role
  const isPharmacy = dashboardKindForRole(role) === 'pharmacy'

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: colors.bgSubtle,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: tabBarHeight + insets.bottom,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: 6,
          elevation: 0,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: styles.tabItem,
        headerStyle: {
          backgroundColor: colors.bg,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSubtle,
        },
        headerTitleStyle: {
          color: colors.text,
          fontWeight: '600',
          fontSize: 17,
          fontFamily: 'DMSans_700Bold',
        },
        headerShadowVisible: false,
        headerTintColor: colors.text,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          headerShown: false,
          href: tabHref(role, 'home'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'home' : 'home-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="records"
        options={{
          title: 'Records',
          headerTitle: 'Health Records',
          href: tabHref(role, 'records'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'document-text' : 'document-text-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="appointments"
        options={{
          title: 'Visits',
          headerTitle: 'Appointments',
          href: tabHref(role, 'appointments'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'calendar' : 'calendar-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="meds"
        options={{
          title: 'Meds',
          headerTitle: 'Medications',
          href: tabHref(role, 'meds'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'medkit' : 'medkit-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="queue"
        options={{
          title: 'Queue',
          headerTitle: "Today's Queue",
          href: tabHref(role, 'queue'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'list' : 'list-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="patients"
        options={{
          title: 'Patients',
          headerTitle: 'Patients',
          href: tabHref(role, 'patients'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'people' : 'people-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'Stock',
          headerTitle: 'Inventory',
          href: tabHref(role, 'stock'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'cube' : 'cube-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          headerTitle: 'Orders',
          href: tabHref(role, 'orders'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'bag-handle' : 'bag-handle-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="sales"
        options={{
          title: 'Sales',
          headerTitle: 'Sales history',
          href: tabHref(role, 'sales'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'cash' : 'cash-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="lab"
        options={{
          title: 'Lab',
          headerTitle: 'Lab Orders',
          href: tabHref(role, 'lab'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'flask' : 'flask-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="claims"
        options={{
          title: 'Claims',
          headerTitle: 'Billing Claims',
          href: tabHref(role, 'claims'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'receipt' : 'receipt-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: isPharmacy ? 'More' : 'Profile',
          headerShown: false,
          href: tabHref(role, 'profile'),
          tabBarIcon: ({ focused }) => (
            <TabIcon
              name={focused ? (isPharmacy ? 'grid' : 'person-circle') : isPharmacy ? 'grid-outline' : 'person-circle-outline'}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen name="settings" options={{ href: null }} />
      <Tabs.Screen name="suppliers" options={{ href: null, title: 'Suppliers', headerTitle: 'Suppliers' }} />
      <Tabs.Screen
        name="purchase-orders"
        options={{ href: null, title: 'Purchase orders', headerTitle: 'Purchase orders' }}
      />
      <Tabs.Screen name="purchases" options={{ href: null, title: 'Purchases', headerTitle: 'Purchases' }} />
      <Tabs.Screen name="reports" options={{ href: null, title: 'Reports', headerTitle: 'Reports' }} />
      <Tabs.Screen name="refunds" options={{ href: null, title: 'Refunds', headerTitle: 'Refunds' }} />
      <Tabs.Screen
        name="pharmacy-settings"
        options={{ href: null, title: 'Pharmacy settings', headerTitle: 'Pharmacy settings' }}
      />
      <Tabs.Screen
        name="pharmacy-users"
        options={{ href: null, title: 'Staff', headerTitle: 'Pharmacy staff' }}
      />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  tabItem: { paddingVertical: 0 },
  tabLabel: {
    fontSize: 11,
    lineHeight: 14,
    marginTop: 2,
    flexShrink: 0,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
})
