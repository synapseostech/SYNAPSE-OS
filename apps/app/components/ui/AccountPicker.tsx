import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TextField } from './TextField'
import type { AccountingAccount } from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type AccountPickerProps = {
  accounts: AccountingAccount[]
  value: string | null
  onChange: (accountId: string | null) => void
  placeholder?: string
  clearLabel?: string
  limit?: number
}

export function AccountPicker({
  accounts,
  value,
  onChange,
  placeholder = 'Choose account',
  clearLabel,
  limit = 10,
}: AccountPickerProps) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = value ? (accounts.find((account) => account.id === value) ?? null) : null

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? accounts.filter((account) =>
          `${account.code ?? ''} ${account.name ?? ''}`.toLowerCase().includes(needle),
        )
      : accounts
    return filtered.slice(0, limit)
  }, [accounts, limit, query])

  const choose = (accountId: string | null) => {
    onChange(accountId)
    setOpen(false)
    setQuery('')
  }

  return (
    <View>
      <Pressable
        onPress={() => {
          setOpen((current) => !current)
          setQuery('')
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={[
          styles.accountButton,
          {
            borderColor: open ? colors.primary : colors.border,
            backgroundColor: open ? colors.primarySoft : colors.bgElevated,
          },
        ]}
      >
        <Text
          style={[styles.accountText, { color: selected ? colors.text : colors.textMuted }]}
          numberOfLines={1}
        >
          {selected ? `${selected.code ?? ''} · ${selected.name ?? ''}` : placeholder}
        </Text>
      </Pressable>

      {open ? (
        <View style={styles.picker}>
          <TextField
            label="Find account"
            value={query}
            onChangeText={setQuery}
            placeholder="Code or name"
            autoCapitalize="none"
          />
          {clearLabel ? (
            <Pressable
              onPress={() => choose(null)}
              accessibilityRole="button"
              style={[styles.option, { borderColor: colors.borderSubtle }]}
            >
              <Text style={[styles.optionName, { color: colors.textSecondary }]}>{clearLabel}</Text>
            </Pressable>
          ) : null}
          {matches.map((option) => (
            <Pressable
              key={option.id}
              onPress={() => choose(option.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: option.id === value }}
              style={[styles.option, { borderColor: colors.borderSubtle }]}
            >
              <Text style={[styles.optionName, { color: colors.text }]} numberOfLines={1}>
                {option.code ?? ''} · {option.name ?? ''}
              </Text>
              <Text style={[styles.optionMeta, { color: colors.textMuted }]} numberOfLines={1}>
                {(option.accountType ?? '').replace(/_/g, ' ') || 'Account'}
              </Text>
            </Pressable>
          ))}
          {matches.length === 0 ? (
            <Text style={[styles.message, { color: colors.textMuted }]}>
              No account matches that search.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  accountButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  accountText: { ...typography.body },
  picker: { marginTop: spacing.sm },
  option: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  optionName: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  optionMeta: { ...typography.caption, marginTop: 2, textTransform: 'capitalize' },
  message: { ...typography.bodySm, lineHeight: 20 },
})
