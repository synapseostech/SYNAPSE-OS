import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { buildTestPageEscPos } from '@/lib/escpos'
import {
  DEFAULT_RAW_PORT,
  describePrinter,
  parsePrinterAddress,
  type PrinterConfig,
  type PrinterKind,
} from '@/lib/printer-config'
import { savePrinterConfig, usePrinterConfig } from '@/lib/printer-store'
import {
  cancelPrinterDiscovery,
  discoverPrinters,
  listPairedPrinters,
  pairPrinter,
  printerTransportsAvailable,
  sendToConfiguredPrinter,
  type BluetoothPrinterCandidate,
} from '@/lib/printer-transport'
import { colors, radii, spacing, typography } from '@/lib/theme'

const KINDS: { key: PrinterKind; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'system', label: 'Print dialog', icon: 'print-outline' },
  { key: 'network', label: 'Wi-Fi / LAN', icon: 'wifi-outline' },
  { key: 'bluetooth', label: 'Bluetooth', icon: 'bluetooth-outline' },
]

/**
 * Receipt printer for this phone: the system print dialog, a networked ESC/POS
 * printer (raw TCP, usually port 9100), or a paired Bluetooth thermal printer.
 * Saved on the device, because the printer belongs to the counter.
 */
export default function PrinterSetupScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { config, loaded } = usePrinterConfig()
  const [form, setForm] = useState<PrinterConfig>(config)
  const [portText, setPortText] = useState(String(config.port))
  const [devices, setDevices] = useState<BluetoothPrinterCandidate[]>([])
  const [busy, setBusy] = useState<null | 'paired' | 'scan' | 'pair' | 'test' | 'save'>(null)
  const available = useMemo(() => printerTransportsAvailable(), [])

  useEffect(() => {
    if (!loaded) return
    setForm(config)
    setPortText(String(config.port))
  }, [loaded, config])

  useEffect(() => () => void cancelPrinterDiscovery(), [])

  const update = (patch: Partial<PrinterConfig>) => setForm((f) => ({ ...f, ...patch }))

  /** The form as it would be saved, or an error to show instead. */
  const resolved = (): { ok: true; config: PrinterConfig } | { ok: false; error: string } => {
    if (form.kind === 'network') {
      const address = parsePrinterAddress(form.host, portText)
      if (!address.ok) return address
      return { ok: true, config: { ...form, host: address.host, port: address.port } }
    }
    if (form.kind === 'bluetooth' && !form.bluetoothAddress) {
      return { ok: false, error: 'Choose a Bluetooth printer from the list first.' }
    }
    return { ok: true, config: form }
  }

  const loadPaired = async () => {
    setBusy('paired')
    try {
      const paired = await listPairedPrinters()
      setDevices(paired)
      if (paired.length === 0) {
        Alert.alert(
          'No paired printers',
          'Turn the printer on, then pair it in Android Bluetooth settings (PIN is usually 0000 or 1234), or tap Scan nearby.',
        )
      }
    } catch (err) {
      Alert.alert('Bluetooth', err instanceof Error ? err.message : 'Could not read paired devices.')
    } finally {
      setBusy(null)
    }
  }

  const scan = async () => {
    setBusy('scan')
    try {
      const found = await discoverPrinters()
      setDevices((current) => {
        const byAddress = new Map(current.map((d) => [d.address, d]))
        for (const d of found) byAddress.set(d.address, { ...byAddress.get(d.address), ...d })
        return [...byAddress.values()]
      })
    } catch (err) {
      Alert.alert('Bluetooth scan', err instanceof Error ? err.message : 'Scan failed.')
    } finally {
      setBusy(null)
    }
  }

  const choose = async (device: BluetoothPrinterCandidate) => {
    let picked = device
    if (!device.bonded) {
      setBusy('pair')
      try {
        picked = await pairPrinter(device.address)
        setDevices((list) => list.map((d) => (d.address === picked.address ? picked : d)))
      } catch (err) {
        Alert.alert(
          'Pairing failed',
          `${err instanceof Error ? err.message : 'The printer did not pair.'}\nTry pairing in Android Bluetooth settings.`,
        )
        return
      } finally {
        setBusy(null)
      }
    }
    update({ bluetoothAddress: picked.address, bluetoothName: picked.name })
  }

  const testPrint = async () => {
    const r = resolved()
    if (!r.ok) {
      Alert.alert('Printer setup', r.error)
      return
    }
    if (r.config.kind === 'system') {
      Alert.alert('Print dialog', 'Receipts open the phone’s print dialog. Choose a direct printer to test it here.')
      return
    }
    setBusy('test')
    try {
      const bytes = buildTestPageEscPos({
        paperWidth: r.config.paperWidth,
        printerLabel: describePrinter(r.config),
        printedAt: new Date().toLocaleString(),
        cut: r.config.cut,
      })
      await sendToConfiguredPrinter(r.config, bytes)
      Alert.alert('Test sent', 'Check the page printed and the ruler line fits on one row. Then save.')
    } catch (err) {
      Alert.alert('Test print failed', err instanceof Error ? err.message : 'The printer did not respond.')
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    const r = resolved()
    if (!r.ok) {
      Alert.alert('Printer setup', r.error)
      return
    }
    setBusy('save')
    try {
      await savePrinterConfig(r.config)
      router.back()
    } catch {
      Alert.alert('Not saved', 'This phone could not store the printer settings. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const kindDisabled = (kind: PrinterKind) =>
    (kind === 'network' && !available.network) || (kind === 'bluetooth' && !available.bluetooth)

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Receipt printer
        </Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <Text style={styles.help}>
          Saved on this phone only. Thermal printers get the receipt directly; the print dialog works with any
          printer Android can see.
        </Text>

        {!available.network || (Platform.OS === 'android' && !available.bluetooth) ? (
          <Text style={styles.warn}>
            This copy of the app was installed before direct printing was added. Install the latest Synapse APK
            to print to Wi-Fi and Bluetooth printers.
          </Text>
        ) : null}

        <Text style={styles.label}>Connection</Text>
        <View style={styles.segment}>
          {KINDS.map((k) => {
            const disabled = kindDisabled(k.key)
            const active = form.kind === k.key
            return (
              <Pressable
                key={k.key}
                disabled={disabled}
                onPress={() => update({ kind: k.key })}
                style={[styles.segmentItem, active && styles.segmentActive, disabled && styles.disabled]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active, disabled }}
              >
                <Ionicons name={k.icon} size={18} color={active ? colors.primaryForeground : colors.text} />
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{k.label}</Text>
              </Pressable>
            )
          })}
        </View>

        {form.kind === 'network' ? (
          <>
            <Text style={styles.label}>Printer IP address</Text>
            <TextInput
              style={styles.input}
              value={form.host}
              onChangeText={(host) => update({ host })}
              placeholder="192.168.1.50"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={Platform.OS === 'android' ? 'visible-password' : 'url'}
              accessibilityLabel="Printer IP address"
            />
            <Text style={styles.label}>Port</Text>
            <TextInput
              style={styles.input}
              value={portText}
              onChangeText={setPortText}
              placeholder={String(DEFAULT_RAW_PORT)}
              placeholderTextColor={colors.textSecondary}
              keyboardType="number-pad"
              accessibilityLabel="Printer port"
            />
            <Text style={styles.meta}>
              Most printers print their IP address on a self-test page: hold the feed button while switching
              the printer on. The phone must be on the same Wi-Fi.
            </Text>
          </>
        ) : null}

        {form.kind === 'bluetooth' ? (
          <>
            <Text style={styles.meta}>
              {form.bluetoothAddress
                ? `Selected: ${form.bluetoothName || form.bluetoothAddress}`
                : 'No printer selected yet.'}
            </Text>
            <View style={styles.row}>
              <Button
                label="Paired printers"
                onPress={() => void loadPaired()}
                loading={busy === 'paired'}
                disabled={busy !== null}
                variant="ghost"
                style={styles.flex}
              />
              <Button
                label="Scan nearby"
                onPress={() => void scan()}
                loading={busy === 'scan'}
                disabled={busy !== null}
                variant="ghost"
                style={styles.flex}
              />
            </View>
            {busy === 'scan' ? <Text style={styles.meta}>Scanning for about 12 seconds…</Text> : null}
            {devices.map((d) => {
              const selected = d.address === form.bluetoothAddress
              return (
                <Pressable
                  key={d.address}
                  onPress={() => void choose(d)}
                  disabled={busy !== null}
                  style={[styles.device, selected && styles.deviceSelected]}
                  accessibilityRole="button"
                  accessibilityLabel={`${d.name}${d.bonded ? '' : ', not paired'}`}
                >
                  <Ionicons
                    name={selected ? 'checkmark-circle' : 'print-outline'}
                    size={20}
                    color={selected ? colors.primary : colors.textSecondary}
                  />
                  <View style={styles.flex}>
                    <Text style={styles.deviceName}>{d.name}</Text>
                    <Text style={styles.meta}>
                      {d.address}
                      {d.bonded ? '' : ' · tap to pair'}
                    </Text>
                  </View>
                  {busy === 'pair' ? <ActivityIndicator color={colors.primary} /> : null}
                </Pressable>
              )
            })}
          </>
        ) : null}

        {form.kind !== 'system' ? (
          <>
            <Text style={styles.label}>Paper width</Text>
            <View style={styles.segment}>
              {(['58', '80'] as const).map((w) => {
                const active = form.paperWidth === w
                return (
                  <Pressable
                    key={w}
                    onPress={() => update({ paperWidth: w })}
                    style={[styles.segmentItem, active && styles.segmentActive]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{w} mm</Text>
                  </Pressable>
                )
              })}
            </View>
            <View style={styles.switchRow}>
              <View style={styles.flex}>
                <Text style={styles.switchLabel}>Cut paper after each receipt</Text>
                <Text style={styles.meta}>Printers without a cutter ignore this.</Text>
              </View>
              <Switch value={form.cut} onValueChange={(cut) => update({ cut })} />
            </View>
          </>
        ) : null}

        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.switchLabel}>Print automatically after a sale</Text>
            <Text style={styles.meta}>
              On this phone only. If the pharmacy requires a printed receipt, it prints after every sale anyway.
            </Text>
          </View>
          <Switch value={form.autoPrint} onValueChange={(autoPrint) => update({ autoPrint })} />
        </View>

        <View style={styles.row}>
          <Button
            label="Test print"
            onPress={() => void testPrint()}
            loading={busy === 'test'}
            disabled={busy !== null || form.kind === 'system'}
            variant="ghost"
            style={styles.flex}
          />
          <Button
            label="Save"
            onPress={() => void save()}
            loading={busy === 'save'}
            disabled={busy !== null}
            style={styles.flex}
          />
        </View>
      </ScrollView>
    </View>
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
  backBtn: { width: 48, height: 44, justifyContent: 'center' },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { paddingHorizontal: spacing.lg, gap: spacing.md },
  help: { ...typography.bodySm, color: colors.textSecondary },
  warn: { ...typography.bodySm, color: colors.warning },
  meta: { ...typography.caption, color: colors.textSecondary },
  label: { ...typography.caption, color: colors.text, marginTop: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    minHeight: 44,
  },
  segment: { flexDirection: 'row', gap: spacing.sm },
  segmentItem: {
    flex: 1,
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
  },
  segmentActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segmentText: { ...typography.caption, color: colors.text },
  segmentTextActive: { color: colors.primaryForeground },
  disabled: { opacity: 0.4 },
  row: { flexDirection: 'row', gap: spacing.sm },
  flex: { flex: 1 },
  device: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    minHeight: 56,
  },
  deviceSelected: { borderColor: colors.primary },
  deviceName: { ...typography.bodySm, color: colors.text },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56 },
  switchLabel: { ...typography.bodySm, color: colors.text },
})
