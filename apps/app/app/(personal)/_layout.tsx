import { Tabs, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Platform, Pressable, StyleSheet } from 'react-native'
import { tabBarHeight, useTheme } from '@/lib/theme'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

function TabIcon({ name, focused }: { name: IoniconsName; focused: boolean }) {
  const { colors } = useTheme()
  return <Ionicons name={name} size={22} color={focused ? colors.primary : colors.textMuted} />
}

/** Screens reachable from Today but not shown in the tab bar. */
function BackToToday() {
  const router = useRouter()
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/(personal)/today' as never))}
      hitSlop={12}
      style={styles.backBtn}
      accessibilityRole="button"
      accessibilityLabel="Back"
    >
      <Ionicons name="chevron-back" size={22} color={colors.primary} />
    </Pressable>
  )
}

export default function PersonalLayout() {
  const { colors } = useTheme()

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: colors.bgSubtle,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: tabBarHeight,
          paddingBottom: Platform.OS === 'ios' ? 8 : 6,
          paddingTop: 6,
          elevation: 0,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: styles.tabLabel,
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
        name="today"
        options={{
          title: 'Today',
          headerShown: false,
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'sunny' : 'sunny-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="vitals"
        options={{
          title: 'Vitals',
          headerTitle: 'Vitals',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'pulse' : 'pulse-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="habits"
        options={{
          title: 'Habits',
          headerTitle: 'Habits',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'checkbox' : 'checkbox-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="cycle"
        options={{
          title: 'Cycle',
          headerTitle: 'Cycle',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'flower' : 'flower-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          headerTitle: 'Activity',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'walk' : 'walk-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="medical-id"
        options={{
          title: 'Health profile',
          headerTitle: 'Health profile',
          href: null,
          headerLeft: () => <BackToToday />,
        }}
      />
      <Tabs.Screen
        name="medications"
        options={{
          title: 'Medicines',
          headerTitle: 'Medicines',
          href: null,
          headerLeft: () => <BackToToday />,
        }}
      />
      <Tabs.Screen
        name="journal"
        options={{
          title: 'Journal',
          headerTitle: 'Health journal',
          href: null,
          headerLeft: () => <BackToToday />,
        }}
      />
      <Tabs.Screen
        name="coach"
        options={{
          title: 'Coach',
          headerTitle: 'Coach',
          href: null,
          headerLeft: () => <BackToToday />,
        }}
      />
      <Tabs.Screen
        name="reminders"
        options={{
          title: 'Reminders',
          headerTitle: 'Reminders',
          href: null,
          headerLeft: () => <BackToToday />,
        }}
      />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  backBtn: { paddingHorizontal: 8 },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
})
