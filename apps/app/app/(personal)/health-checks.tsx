import { useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import {
  ageOn,
  healthChecksFor,
  pregnancyProgress,
  SEX_AT_BIRTH_OPTIONS,
  type HealthSections,
} from '@/lib/health-sections'
import { useHealthSections } from '@/lib/use-health-sections'
import { spacing, typography, useTheme } from '@/lib/theme'

const SECTION_LABELS: Array<{ key: keyof HealthSections; label: string; hint: string }> = [
  { key: 'cycle', label: 'Cycle tracking', hint: 'Periods, symptoms, cervical and breast checks' },
  { key: 'pregnancy', label: 'Pregnancy', hint: 'Weeks, trimester and antenatal visits' },
  { key: 'mensHealth', label: "Men's health", hint: 'Prostate and testicular checks' },
]

const EVERY: Record<string, string> = { month: 'Monthly', year: 'Yearly', three_years: 'Every 3 years' }

export default function HealthChecksScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const { loaded, sex, sections, dateOfBirth, pregnancyDueDate, save } = useHealthSections()
  const [due, setDue] = useState('')

  useEffect(() => {
    setDue(pregnancyDueDate ?? '')
  }, [pregnancyDueDate])

  const age = ageOn(dateOfBirth)
  const checks = healthChecksFor(sections, age)
  const progress = pregnancyProgress(pregnancyDueDate)

  const saveDue = async () => {
    const value = due.trim()
    if (value && !pregnancyProgress(value)) {
      Alert.alert('Check the date', 'Enter your due date as YYYY-MM-DD, within the next 40 weeks.')
      return
    }
    await save({ pregnancyDueDate: value || null })
  }

  if (!loaded) return <Screen>{null}</Screen>

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll}>
        {sections.pregnancy ? (
          <>
            <SectionHeader title="Pregnancy" />
            <Card>
              {progress ? (
                <>
                  <Text style={[styles.big, { color: colors.text }]}>
                    {progress.weeks} weeks{progress.days ? ` ${progress.days} days` : ''}
                  </Text>
                  <Text style={[styles.muted, { color: colors.textSecondary }]}>
                    Trimester {progress.trimester} · {progress.daysToGo} days to your due date
                  </Text>
                </>
              ) : (
                <Text style={[styles.muted, { color: colors.textSecondary }]}>
                  Pregnant? Add your due date to see your weeks. Your antenatal clinic gives it at the first visit.
                </Text>
              )}
              <TextField label="Due date" value={due} onChangeText={setDue} placeholder="YYYY-MM-DD" />
              <View style={styles.row}>
                <Button label="Save" onPress={saveDue} style={styles.flex} />
                <Button
                  label="Add a visit"
                  variant="ghost"
                  onPress={() => router.push('/(personal)/reminders' as never)}
                  style={styles.flex}
                />
              </View>
            </Card>
          </>
        ) : null}

        <SectionHeader title="Checks to stay on top of" style={styles.spacer} />
        {checks.map((check) => (
          <Card key={check.id}>
            <Text style={[styles.title, { color: colors.text }]}>{check.title}</Text>
            <Text style={[styles.muted, { color: colors.textSecondary }]}>{check.detail}</Text>
            <View style={styles.checkFooter}>
              <Text style={[styles.caption, { color: colors.textMuted }]}>{EVERY[check.every]}</Text>
              <Pressable onPress={() => router.push('/(personal)/reminders' as never)} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.link, { color: colors.primary }]}>Set a reminder</Text>
              </Pressable>
            </View>
          </Card>
        ))}
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          General guidance, not a diagnosis. Your clinician may advise differently.
        </Text>

        <SectionHeader title="What My Health shows" style={styles.spacer} />
        <Card>
          <ChoiceChips
            label="Sex at birth"
            options={SEX_AT_BIRTH_OPTIONS}
            value={sex}
            onChange={(value) => save({ sex: value })}
          />
          <Text style={[styles.caption, { color: colors.textMuted }]}>
            Only used to suggest the sections below. Turn any of them on or off.
          </Text>
          {SECTION_LABELS.map((item) => (
            <View key={item.key} style={styles.toggleRow}>
              <View style={styles.flex}>
                <Text style={[styles.title, { color: colors.text }]}>{item.label}</Text>
                <Text style={[styles.caption, { color: colors.textMuted }]}>{item.hint}</Text>
              </View>
              <Switch
                value={sections[item.key]}
                onValueChange={(value) => save({ sections: { [item.key]: value } })}
                accessibilityLabel={item.label}
              />
            </View>
          ))}
        </Card>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md, paddingBottom: spacing.xxxl },
  spacer: { marginTop: spacing.lg },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.md },
  big: { ...typography.h2 },
  title: { ...typography.bodyMedium },
  muted: { ...typography.bodySm, marginBottom: spacing.sm },
  caption: { ...typography.caption },
  link: { ...typography.bodyMedium },
  checkFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
})
