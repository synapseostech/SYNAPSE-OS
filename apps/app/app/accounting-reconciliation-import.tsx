import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  importBankStatement,
  type BankStatementImportResult,
} from '@/lib/api'
import { isoLocal } from '@/lib/ranges'
import { spacing, typography, useTheme } from '@/lib/theme'

/** Stable per attempt, so a retry after a dropped connection replays instead of importing twice. */
function newIdempotencyKey(): string {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export default function AccountingReconciliationImportScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()

  const [fileName, setFileName] = useState(() => `statement-${isoLocal(new Date())}.csv`)
  const [currency, setCurrency] = useState('')
  const [csv, setCsv] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BankStatementImportResult | null>(null)

  const validCurrency = /^[A-Za-z]{3}$/.test(currency.trim())
  const canSubmit =
    Boolean(token) &&
    fileName.trim().length > 0 &&
    validCurrency &&
    csv.trim().length > 0 &&
    !submitting

  const submit = async () => {
    if (!token || !canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const imported = await importBankStatement(token, {
        fileName: fileName.trim(),
        currency: currency.trim().toUpperCase(),
        csv,
        idempotencyKey,
      })
      setResult(imported)
      setCsv('')
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message || 'Could not import the bank statement.'
          : 'Could not import the bank statement.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const importAnother = () => {
    setResult(null)
    setError(null)
    setCsv('')
    setIdempotencyKey(newIdempotencyKey())
  }

  return (
    <ScreenShell title="Import statement" contentStyle={styles.content}>
      {result ? (
        <>
          <Card>
            <Text style={[styles.title, { color: colors.text }]}>
              {result.replayed ? 'Already imported' : 'Statement imported'}
            </Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {result.replayed
                ? 'This statement was imported before, so nothing was duplicated.'
                : `${result.rowCount.toLocaleString()} line${result.rowCount === 1 ? '' : 's'} ready to reconcile.`}
            </Text>
          </Card>
          <Button
            label="Open reconciliation"
            onPress={() => router.replace('/accounting-reconciliation' as never)}
          />
          <Button label="Import another" variant="ghost" onPress={importAnother} />
        </>
      ) : (
        <>
          <TextField
            label="File name"
            value={fileName}
            onChangeText={setFileName}
            autoCapitalize="none"
            maxLength={255}
            hint="A label to recognise this import later"
          />

          <TextField
            label="Currency"
            value={currency}
            onChangeText={(value) => setCurrency(value.toUpperCase())}
            placeholder="UGX"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={3}
            hint="The statement's currency code"
          />
          {currency.length > 0 && !validCurrency ? (
            <Text style={[styles.note, { color: colors.warning }]}>
              Use a three-letter currency code.
            </Text>
          ) : null}

          <TextField
            label="Statement CSV"
            value={csv}
            onChangeText={setCsv}
            placeholder={'Date,Description,Amount,Reference\n2026-10-20,Customer deposit,125000.00,TX-1'}
            multiline
            numberOfLines={10}
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.csvInput}
            hint="Needs Date, Description and Amount columns, or separate Debit and Credit columns"
          />

          {error ? (
            <Card>
              <Text style={[styles.body, { color: colors.error }]}>{error}</Text>
            </Card>
          ) : null}

          <Button
            label={submitting ? 'Importing…' : 'Import'}
            loading={submitting}
            disabled={!canSubmit}
            onPress={submit}
          />

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Paste the statement as text — the phone has no file picker here. Up to 1 MB or 5,000
            rows at a time, one currency per statement. Rows that fail to parse are named in the
            error, so nothing is imported on a bad file.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  title: { ...typography.h4, marginBottom: spacing.xs },
  body: { ...typography.bodySm, lineHeight: 20 },
  note: { ...typography.caption, marginTop: -spacing.sm, lineHeight: 18 },
  csvInput: { minHeight: 200, paddingTop: spacing.md, fontFamily: 'IBMPlexMono_400Regular', fontSize: 12 },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
