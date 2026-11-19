import { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type Props = {
  visible: boolean
  title?: string
  hint?: string
  onScanned: (code: string) => void
  onClose: () => void
}

const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'] as const

/**
 * Full-screen camera that hands back the first code it reads. The caller
 * decides what a code means; the same code is ignored for two seconds so a
 * pack held still is not read twice.
 */
export function ScannerModal({ visible, title = 'Scan barcode', hint, onScanned, onClose }: Props) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [torch, setTorch] = useState(false)
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 })

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      requestPermission().catch(() => {})
    }
  }, [visible, permission, requestPermission])

  const handle = ({ data }: { data: string }) => {
    const code = String(data ?? '').trim()
    if (!code) return
    const now = Date.now()
    if (last.current.code === code && now - last.current.at < 2000) return
    last.current = { code, at: now }
    onScanned(code)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: '#000', paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close scanner">
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>
          <Text style={[styles.title, { color: '#fff' }]}>{title}</Text>
          <Pressable
            onPress={() => setTorch((t) => !t)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
          >
            <Ionicons name={torch ? 'flash' : 'flash-outline'} size={24} color="#fff" />
          </Pressable>
        </View>
        {permission?.granted ? (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
              onBarcodeScanned={visible ? handle : undefined}
            />
            <View pointerEvents="none" style={styles.frameWrap}>
              <View style={[styles.frame, { borderColor: colors.primary }]} />
            </View>
          </View>
        ) : (
          <View style={styles.perm}>
            <Text style={[styles.permText, { color: '#fff' }]}>
              The camera is needed to scan. You can also search by name.
            </Text>
            <Button label="Allow camera" onPress={() => requestPermission()} />
          </View>
        )}
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Text style={[styles.hint, { color: '#ddd' }]}>{hint ?? 'Hold the barcode inside the frame'}</Text>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { ...typography.h3 },
  cameraWrap: { flex: 1, overflow: 'hidden' },
  frameWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  frame: { width: '78%', height: 170, borderWidth: 3, borderRadius: radii.lg },
  perm: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  permText: { ...typography.body, textAlign: 'center' },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  hint: { ...typography.bodySm, textAlign: 'center' },
})
