import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, searchPosProducts } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

type ProductHit = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  price: number
  quantity: number
}

export default function BarcodeScanScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [manualCode, setManualCode] = useState('')
  const [result, setResult] = useState<ProductHit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [lookingUp, setLookingUp] = useState(false)
  const lastScan = useRef<string>('')

  const lookup = useCallback(
    async (code: string) => {
      if (!token || !code.trim()) return
      setLookingUp(true)
      setError(null)
      try {
        const data = await searchPosProducts(token, code.trim())
        // A scan must match the code exactly. The search endpoint is a
        // substring match, so falling back to its first hit offered whatever
        // product happened to contain the digits — and "Add to sale" then rang
        // up the wrong item.
        const exact = data.products.find(
          (p) =>
            String(p.barcode ?? '').toLowerCase() === code.trim().toLowerCase() ||
            String(p.sku ?? '').toLowerCase() === code.trim().toLowerCase(),
        )
        if (!exact) {
          setResult(null)
          setError(`No product found for “${code.trim()}”`)
          return
        }
        setResult({
          id: exact.id,
          name: exact.name,
          sku: exact.sku,
          barcode: exact.barcode,
          price: exact.price,
          quantity: exact.sellableQuantity ?? exact.quantity,
        })
        setScanning(false)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Lookup failed')
        setResult(null)
      } finally {
        setLookingUp(false)
      }
    },
    [token],
  )

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission().catch(() => {})
    }
  }, [permission, requestPermission])

  const onBarcodeScanned = ({ data }: { data: string }) => {
    if (!scanning || lookingUp) return
    if (data === lastScan.current) return
    lastScan.current = data
    setManualCode(data)
    lookup(data)
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Barcode lookup</Text>
        <View style={{ width: 40 }} />
      </View>

      {permission?.granted ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],
            }}
            onBarcodeScanned={scanning ? onBarcodeScanned : undefined}
          />
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>
              {scanning ? 'Point at a barcode' : 'Paused'}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.permBox}>
          <Text style={styles.permText}>
            Camera permission is needed for live scanning. You can still enter a barcode manually.
          </Text>
          {!permission?.granted ? (
            <Button label="Allow camera" onPress={() => requestPermission()} />
          ) : null}
        </View>
      )}

      <View style={[styles.panel, { paddingBottom: insets.bottom + spacing.lg }]}>
        <TextField
          label="Or enter barcode / SKU"
          value={manualCode}
          onChangeText={setManualCode}
          autoCapitalize="characters"
          placeholder="Scan or type code"
        />
        <Button
          label={lookingUp ? 'Looking up…' : 'Look up product'}
          onPress={() => lookup(manualCode)}
          loading={lookingUp}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {result ? (
          <View style={styles.result}>
            <Text style={styles.resultName}>{result.name}</Text>
            <Text style={styles.resultMeta}>
              {[result.sku, result.barcode].filter(Boolean).join(' · ') || 'No codes'}
            </Text>
            <Text style={styles.resultMeta}>
              UGX {Number(result.price).toLocaleString()} · Qty {result.quantity}
            </Text>
            <View style={styles.actions}>
              <Button
                label="Add to sale"
                onPress={() => router.push(`/pos?barcode=${encodeURIComponent(result.barcode ?? result.sku ?? '')}` as never)}
              />
              <Button
                label="Open product"
                variant="ghost"
                onPress={() => router.push(`/stock-item/${result.id}` as never)}
              />
              <Button
                label="Receive stock"
                variant="ghost"
                onPress={() => router.push('/stock-receive' as never)}
              />
              <Button
                label="Scan again"
                variant="ghost"
                onPress={() => {
                  setResult(null)
                  setError(null)
                  setScanning(true)
                  lastScan.current = ''
                }}
              />
            </View>
          </View>
        ) : null}
      </View>
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
  backBtn: { width: 40 },
  title: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold' },
  cameraWrap: {
    height: 280,
    marginHorizontal: spacing.lg,
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: colors.bgElevated,
  },
  camera: { flex: 1 },
  overlay: {
    position: 'absolute',
    bottom: 12,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  overlayText: {
    color: colors.white,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.sm,
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
  },
  permBox: { padding: spacing.xl },
  permText: {
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginBottom: spacing.lg,
  },
  panel: { padding: spacing.xl, flex: 1 },
  error: { color: colors.danger, marginTop: spacing.md, fontFamily: 'DMSans_400Regular' },
  result: {
    marginTop: spacing.xl,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  resultName: { color: colors.text, fontFamily: 'DMSans_700Bold', fontSize: 16 },
  resultMeta: {
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 4,
    fontSize: 13,
  },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
})
