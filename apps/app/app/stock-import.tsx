import { useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as XLSX from 'xlsx'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

const SAMPLE = `name,sku,price,quantity,cost_price,category,unit,batch,expiry
Amoxicillin 500mg,AMX-500,2500,100,1800,Antibiotics,Tablet,B1,2027-06-30
ORS Sachet,ORS-1,500,200,300,OTC,Sachet,,`

/** Read a picked CSV/XLSX file from the phone and return CSV text for bulk-upload. */
async function fileToCsv(uri: string, name: string): Promise<string> {
  const lower = name.toLowerCase()
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 })
  }
  // XLSX / XLS: read as base64 and convert the first sheet to CSV on-device.
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
  const wb = XLSX.read(b64, { type: 'base64' })
  const first = wb.SheetNames[0]
  if (!first) throw new Error('The spreadsheet has no sheets.')
  return XLSX.utils.sheet_to_csv(wb.Sheets[first])
}

export default function StockImportScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [csv, setCsv] = useState(SAMPLE)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickedName, setPickedName] = useState<string | null>(null)

  const pickFile = async () => {
    setPicking(true)
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/plain',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      })
      if (res.canceled || !res.assets?.length) return
      const file = res.assets[0]
      const text = await fileToCsv(file.uri, file.name ?? 'import.csv')
      if (!text.trim()) {
        Alert.alert('Empty file', 'That file has no rows.')
        return
      }
      setCsv(text)
      setPickedName(file.name ?? 'file')
    } catch (err) {
      Alert.alert('Could not read file', err instanceof Error ? err.message : 'Try another file.')
    } finally {
      setPicking(false)
    }
  }

  const runImport = async () => {
    if (!token) return
    if (!csv.trim()) {
      Alert.alert('Empty CSV', 'Paste product rows first.')
      return
    }
    setSaving(true)
    try {
      const data = await apiRequest<{
        ok: boolean
        created: number
        skipped: string[]
        errors: string[]
      }>('/api/mobile/pharmacy/inventory/bulk-upload', {
        method: 'POST',
        token,
        body: { csv },
      })
      const bits = [
        `Created ${data.created}`,
        data.skipped.length ? `skipped ${data.skipped.length}` : null,
        data.errors.length ? `errors ${data.errors.length}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      Alert.alert('Import finished', bits, [
        { text: 'Stock list', onPress: () => router.replace('/(main)/stock' as never) },
        { text: 'OK' },
      ])
    } catch (err) {
      Alert.alert(
        'Import failed',
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Try again',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Bulk import</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.help}>
          Choose a CSV or Excel (.xlsx) file from your phone, or paste rows below. Header row with
          flexible columns: name, sku, price, quantity, cost_price, category, unit, batch, expiry.
          Rows need a genuine batch and future expiry to become sellable stock.
        </Text>

        <Button
          label={pickedName ? `Selected: ${pickedName} — choose another` : 'Choose CSV / Excel file'}
          onPress={pickFile}
          loading={picking}
          variant="ghost"
        />

        <TextInput
          style={styles.area}
          value={csv}
          onChangeText={setCsv}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
          placeholderTextColor={colors.textMuted}
        />

        <Button label="Import" onPress={runImport} loading={saving} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backBtn: { width: 48 },
  title: {
    ...typography.h3,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  content: { padding: spacing.xl, gap: spacing.md },
  help: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 20,
  },
  area: {
    minHeight: 220,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    color: colors.text,
    backgroundColor: colors.bgElevated,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
  },
})
