import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  addHabit,
  archiveHabit,
  listHabits,
  logHabit,
  type Habit,
  type HabitCategory,
} from '@/lib/personal-store'
import { spacing, typography, useTheme } from '@/lib/theme'

const CATEGORIES = [
  { value: 'exercise', label: 'Exercise' },
  { value: 'sleep', label: 'Sleep' },
  { value: 'hydration', label: 'Water' },
  { value: 'meditation', label: 'Mindfulness' },
  { value: 'custom', label: 'Other' },
] as const

export default function PersonalHabitsScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [habits, setHabits] = useState<Habit[]>([])
  const [name, setName] = useState('')
  const [category, setCategory] = useState<HabitCategory>('exercise')
  const [target, setTarget] = useState('')
  const [unit, setUnit] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      setHabits(await listHabits(userId))
    } catch {
      setError('Could not read the habits saved on this device.')
    }
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload]),
  )

  const create = async () => {
    setError(null)
    if (!userId) return
    if (!name.trim()) {
      setError('Give the habit a name.')
      return
    }
    const numeric = Number(target)
    const hasTarget = target.trim().length > 0 && Number.isFinite(numeric)
    setAdding(true)
    try {
      await addHabit({
        userId,
        name,
        category,
        targetValue: hasTarget ? numeric : null,
        targetUnit: hasTarget ? unit : null,
      })
      setName('')
      setTarget('')
      setUnit('')
      await reload()
    } catch {
      setError('Could not save the habit on this device.')
    } finally {
      setAdding(false)
    }
  }

  const tick = async (habit: Habit) => {
    if (!userId || habit.loggedToday) return
    await logHabit({ userId, habitId: habit.id })
    await reload()
  }

  const archive = (habit: Habit) => {
    Alert.alert('Remove habit', `Stop tracking "${habit.name}"? Its history stays on this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          if (!userId) return
          await archiveHabit(userId, habit.id)
          await reload()
        },
      },
    ])
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SectionHeader title="Today" />
        {habits.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              No habits yet. Add one below and tap it each day to keep a streak.
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {habits.map((habit) => (
              <Pressable
                key={habit.id}
                onPress={() => tick(habit)}
                onLongPress={() => archive(habit)}
                accessibilityRole="button"
                accessibilityState={{ checked: habit.loggedToday }}
                accessibilityLabel={`${habit.name}, ${habit.loggedToday ? 'done today' : 'not done today'}`}
              >
                <Card>
                  <View style={styles.habitRow}>
                    <Ionicons
                      name={habit.loggedToday ? 'checkmark-circle' : 'ellipse-outline'}
                      size={24}
                      color={habit.loggedToday ? colors.success : colors.textMuted}
                    />
                    <View style={styles.habitText}>
                      <Text style={[styles.habitName, { color: colors.text }]}>{habit.name}</Text>
                      <Text style={[styles.habitMeta, { color: colors.textMuted }]}>
                        {habit.streak > 0
                          ? `${habit.streak} day${habit.streak === 1 ? '' : 's'} in a row`
                          : 'No streak yet'}
                        {habit.targetValue != null
                          ? ` · target ${habit.targetValue}${habit.targetUnit ? ` ${habit.targetUnit}` : ''}`
                          : ''}
                      </Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        <SectionHeader title="Add a habit" style={styles.spacer} />
        <Card style={styles.formCard}>
          <TextField
            label="Habit"
            value={name}
            onChangeText={setName}
            placeholder="Walk 30 minutes"
          />
          <ChoiceChips
            label="Category"
            options={CATEGORIES}
            value={category}
            onChange={setCategory}
          />
          <View style={styles.row}>
            <View style={styles.rowItem}>
              <TextField
                label="Target (optional)"
                value={target}
                onChangeText={setTarget}
                placeholder="30"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.rowItem}>
              <TextField
                label="Unit (optional)"
                value={unit}
                onChangeText={setUnit}
                placeholder="min"
              />
            </View>
          </View>

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Add habit" onPress={create} loading={adding} />
        </Card>

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Tap a habit to mark it done for today. Long press it to stop tracking.
        </Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  list: { gap: spacing.sm },
  habitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  habitText: { flex: 1, gap: 2 },
  habitName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  habitMeta: { ...typography.caption },
  spacer: { marginTop: spacing.lg },
  formCard: { gap: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.md },
  rowItem: { flex: 1 },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
