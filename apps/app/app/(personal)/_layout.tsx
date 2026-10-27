import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Platform, StyleSheet } from 'react-native'
import { tabBarHeight, useTheme } from '@/lib/theme'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

function TabIcon({ name, focused }: { name: IoniconsName; focused: boolean }) {
  const { colors } = useTheme()
  return <Ionicons name={name} size={22} color={focused ? colors.primary : colors.textMuted} />
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
    </Tabs>
  )
}

const styles = StyleSheet.create({
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
})
