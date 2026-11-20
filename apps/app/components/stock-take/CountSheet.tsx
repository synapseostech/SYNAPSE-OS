import { useEffect, useMemo, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import {
  UNBATCHED_KEY,
  batchKeyFor,
  formatExpiry,
  normaliseBatchNumber,
  parseCountInput,
  parseExpiryInput,
  type LocalCountEntry,
  type StockTakeItem,
} from '@/lib/stock-take'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export type CountLineChange = {
  batchId: string | null
  newBatchNumber: string | null
  newExpiryDate: string | null
  countedQty: number | null
}

type Props = {
  item: StockTakeItem | null
  entries: LocalCountEntry[]
  showBook: boolean
  readOnly: boolean
  fromScan: boolean
  onSave: (changes: CountLineChange[], scanNext: boolean) => void
  onClose: () => void
}

type Row = {
  key: string
  label: string
  detail: string
  batchId: string | null
  newBatchNumber: string | null
  newExpiryDate: string | null
  book?: number
}

/**
 * Count one product: a box per batch on the book, one for stock with no batch
 * label, and any batch found on the shelf that the book does not know.
 * Typing "3x20+5" counts three boxes of twenty and five loose.
 */
export function CountSheet({ item, entries, showBook, readOnly, fromScan, onSave, onClose }: Props) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [values, setValues] = useState<Record<string, string>>({})
  const [found, setFound] = useState<Row[]>([])
  const [newNumber, setNewNumber] = useState('')
  const [newExpiry, setNewExpiry] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mine = useMemo(
    () => (item ? entries.filter((e) => e.productId === item.id) : []),
    [entries, item],
  )

  useEffect(() => {
    if (!item) return
    const initial: Record<string, string> = {}
    for (const entry of mine) {
      if (entry.countedQty !== null) initial[entry.batchKey] = String(entry.countedQty)
    }
    setValues(initial)
    setFound(
      mine
        .filter((e) => e.newBatchNumber && e.countedQty !== null)
        .map((e) => ({
          key: e.batchKey,
          label: e.newBatchNumber ?? '',
          detail: `Found on shelf · exp ${formatExpiry(e.newExpiryDate)}`,
          batchId: null,
          newBatchNumber: e.newBatchNumber,
          newExpiryDate: e.newExpiryDate,
        })),
    )
    setNewNumber('')
    setNewExpiry('')
    setError(null)
    // Reset only when a different product opens: a background sync must not
    // wipe what the counter is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id])

  if (!item) return null

  const rows: Row[] = [
    ...item.batches.map((b) => ({
      key: b.id,
      label: b.batchNumber,
      detail: `exp ${formatExpiry(b.expiryDate)}${b.status !== 'active' ? ` · ${b.status}` : ''}`,
      batchId: b.id,
      newBatchNumber: null,
      newExpiryDate: null,
      book: b.bookQty,
    })),
    {
      key: UNBATCHED_KEY,
      label: item.batches.length > 0 ? 'Batch not readable' : 'Quantity',
      detail: item.batches.length > 0 ? 'Loose or unlabelled stock' : 'No batches on the book',
      batchId: null,
      newBatchNumber: null,
      newExpiryDate: null,
    },
    ...found,
  ]

  const total = rows.reduce((sum, row) => {
    const n = parseCountInput(values[row.key] ?? '')
    return n === null || Number.isNaN(n) ? sum : sum + n
  }, 0)

  const addFound = () => {
    const number = normaliseBatchNumber(newNumber)
    const expiry = parseExpiryInput(newExpiry)
    if (!number) return setError('Type the batch number printed on the pack.')
    if (!expiry) return setError('Expiry as MM/YY, e.g. 03/28.')
    const existing = item.batches.find((b) => normaliseBatchNumber(b.batchNumber) === number)
    const key = existing ? existing.id : batchKeyFor({ newBatchNumber: number })
    if (!existing && !found.some((f) => f.key === key)) {
      setFound((list) => [
        ...list,
        {
          key,
          label: number,
          detail: `Found on shelf · exp ${formatExpiry(expiry)}`,
          batchId: null,
          newBatchNumber: number,
          newExpiryDate: expiry,
        },
      ])
    }
    setNewNumber('')
    setNewExpiry('')
    setError(null)
  }

  const save = (scanNext: boolean) => {
    const changes: CountLineChange[] = []
    for (const row of rows) {
      const raw = values[row.key] ?? ''
      const parsed = parseCountInput(raw)
      if (parsed !== null && Number.isNaN(parsed)) {
        setError(`“${raw}” is not a count for ${row.label}. Use numbers, x and +.`)
        return
      }
      const previous = mine.find((e) => e.batchKey === row.key)
      const before = previous?.countedQty ?? null
      if (parsed === before) continue
      if (parsed === null && !previous) continue
      changes.push({
        batchId: row.batchId,
        newBatchNumber: row.newBatchNumber,
        newExpiryDate: row.newExpiryDate,
        countedQty: parsed,
      })
    }
    onSave(changes, scanNext)
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
      >
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.bg, paddingBottom: insets.bottom + spacing.lg, borderColor: colors.border },
          ]}
        >
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={[styles.meta, { color: colors.textMuted }]}>
                {[item.sku, item.barcode, item.unit].filter(Boolean).join(' · ')}
                {showBook && item.bookQty !== undefined ? ` · book ${item.bookQty}` : ''}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 420 }}>
            {rows.map((row, index) => (
              <View key={row.key} style={[styles.row, { borderColor: colors.borderSubtle }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.batch, { color: colors.text }]}>{row.label}</Text>
                  <Text style={[styles.meta, { color: colors.textMuted }]}>
                    {row.detail}
                    {showBook && row.book !== undefined ? ` · book ${row.book}` : ''}
                  </Text>
                </View>
                <TextInput
                  value={values[row.key] ?? ''}
                  onChangeText={(text) => setValues((v) => ({ ...v, [row.key]: text }))}
                  editable={!readOnly}
                  keyboardType="numbers-and-punctuation"
                  placeholder="—"
                  placeholderTextColor={colors.textMuted}
                  autoFocus={index === 0 && !readOnly}
                  selectTextOnFocus
                  accessibilityLabel={`Counted for ${row.label}`}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.bgElevated },
                  ]}
                />
              </View>
            ))}

            {!readOnly ? (
              <View style={[styles.foundBox, { borderColor: colors.border }]}>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>Found a batch not listed?</Text>
                <View style={styles.foundRow}>
                  <TextInput
                    value={newNumber}
                    onChangeText={setNewNumber}
                    placeholder="Batch no."
                    autoCapitalize="characters"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.foundInput, { flex: 1.4, color: colors.text, borderColor: colors.border }]}
                  />
                  <TextInput
                    value={newExpiry}
                    onChangeText={setNewExpiry}
                    placeholder="MM/YY"
                    keyboardType="numbers-and-punctuation"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.foundInput, { flex: 1, color: colors.text, borderColor: colors.border }]}
                  />
                  <Pressable
                    onPress={addFound}
                    style={[styles.addBtn, { backgroundColor: colors.primarySoft }]}
                    accessibilityRole="button"
                    accessibilityLabel="Add found batch"
                  >
                    <Ionicons name="add" size={20} color={colors.primary} />
                  </Pressable>
                </View>
              </View>
            ) : null}
          </ScrollView>

          {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
          <Text style={[styles.total, { color: colors.text }]}>Counted here: {total}</Text>
          {readOnly ? (
            <Text style={[styles.meta, { color: colors.warning }]}>Counting has closed. These figures are read only.</Text>
          ) : (
            <View style={styles.actions}>
              <Button label="Save" onPress={() => save(false)} style={{ flex: 1 }} variant={fromScan ? 'ghost' : 'primary'} />
              {fromScan ? <Button label="Save & scan next" onPress={() => save(true)} style={{ flex: 1.4 }} /> : null}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii['2xl'],
    borderTopRightRadius: radii['2xl'],
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  head: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  name: { ...typography.h3 },
  meta: { ...typography.bodySm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  batch: { ...typography.bodyMedium },
  input: {
    ...typography.h3,
    width: 104,
    textAlign: 'right',
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  foundBox: { marginTop: spacing.md, borderWidth: 1, borderStyle: 'dashed', borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  foundRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  foundInput: { ...typography.body, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  addBtn: { width: 40, height: 40, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  error: { ...typography.bodySm },
  total: { ...typography.h4 },
  actions: { flexDirection: 'row', gap: spacing.md },
})
