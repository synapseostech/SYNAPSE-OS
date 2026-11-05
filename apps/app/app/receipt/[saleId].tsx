import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  BackHandler,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Print from 'expo-print'
import * as Sharing from 'expo-sharing'
import * as MailComposer from 'expo-mail-composer'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAuth } from '@/lib/auth'
import { apiRequest, apiFetchText, ApiError } from '@/lib/api'
import { resolveReceiptExit } from '@/lib/receipt-print-gate'
import { colors, radii, spacing, typography, TONE_COLORS } from '@/lib/theme'

interface ReceiptLine {
  name: string
  genericName: string | null
  strength: string | null
  dosageForm: string | null
  quantity: number
  unit: string | null
  packageName: string | null
  unitPrice: number
  discount: number
  lineTotal: number
  batchNumber: string | null
  expiryDate: string | null
  manufacturer: string | null
}

interface ReceiptSnapshot {
  saleId: string
  receiptNumber: string
  documentLabel: string
  isFiscal: boolean
  status: string
  isReprint: boolean
  dateTimeKampala: string
  pharmacy: {
    legalName: string
    tradingName: string | null
    address: string | null
    phone: string | null
    tin: string | null
    ndaLicenseNumber: string | null
    supervisingPharmacist: string | null
    pharmacistRegNumber: string | null
    receiptFooter: string | null
  }
  branch: string | null
  cashier: string | null
  patientName: string | null
  currency: string
  lines: ReceiptLine[]
  subtotal: number
  discountTotal: number
  taxAmount: number
  tax?: {
    source: 'vat' | 'legacy' | 'none'
    ratePct: number | null
    taxableAmount: number
    exemptAmount: number
    zeroRatedAmount: number
  } | null
  totalAmount: number
  payment: { method: string; reference: string | null; amountReceived: number | null; change: number | null }
  fiscal: { status: string; documentNumber: string | null; verificationCode: string | null }
}

export default function ReceiptScreen() {
  const { saleId, autoprint, mandatory } = useLocalSearchParams<{
    saleId: string
    autoprint?: string
    mandatory?: string
  }>()
  const { token } = useAuth()
  const router = useRouter()
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const [receipt, setReceipt] = useState<ReceiptSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<null | string>(null)
  const autoPrintTried = useRef(false)
  // The last print outcome this device recorded on the server. `requested`
  // means the print sheet opened; it is not proof that paper came out, so the
  // wording below never says "printed".
  const [printOutcome, setPrintOutcome] = useState<'requested' | 'failed' | null>(null)
  const [printUnrecorded, setPrintUnrecorded] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundReason, setRefundReason] = useState('')
  const requiresPrintDecision = mandatory === '1'
  // The prompt is an instruction until the exit is gated: back must lead to
  // one of the two decisions, never past them.
  const blockExit =
    resolveReceiptExit({
      mandatory: requiresPrintDecision,
      status: receipt?.status,
      outcome: printOutcome,
    }) === 'decide'
  const printerUnavailableNote =
    'The sale is saved and no money needs to be taken again. Reprint this receipt from Transactions when a printer is available.'

  const money = (n: number) => `${receipt?.currency ?? 'UGX'} ${Number(n).toLocaleString()}`

  const load = useCallback(async () => {
    if (!token || !saleId) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ receipt: ReceiptSnapshot }>(
        `/api/mobile/pharmacy/sales/${saleId}/receipt`,
        { token },
      )
      setReceipt(data.receipt)
    } catch {
      setReceipt(null)
    } finally {
      setLoading(false)
    }
  }, [token, saleId])

  useEffect(() => {
    load()
  }, [load])

  const makePdfUri = useCallback(
    async (reprint: boolean): Promise<string> => {
      const html = await apiFetchText(
        `/api/mobile/pharmacy/sales/${saleId}/receipt.pdf${reprint ? '?reprint=1' : ''}`,
        { token },
      )
      const { uri } = await Print.printToFileAsync({ html })
      return uri
    },
    [saleId, token],
  )

  const logShare = useCallback(
    async (channel: string) => {
      try {
        await apiRequest(`/api/mobile/pharmacy/sales/${saleId}/share-log`, {
          method: 'POST',
          token,
          body: { channel },
        })
      } catch {
        /* non-fatal */
      }
    },
    [saleId, token],
  )

  /**
   * Record the print outcome on the sale through the same audited endpoint the
   * web till uses. Returns false when the server did not record it, so the
   * cashier is told the status is missing rather than being left to assume.
   */
  const reportPrintOutcome = useCallback(
    async (outcome: 'requested' | 'failed', reason?: string): Promise<boolean> => {
      try {
        await apiRequest(`/api/mobile/pharmacy/sales/${saleId}/print-status`, {
          method: 'POST',
          token,
          body: { outcome, reason },
        })
        setPrintOutcome(outcome)
        setPrintUnrecorded(false)
        return true
      } catch {
        setPrintUnrecorded(true)
        return false
      }
    },
    [saleId, token],
  )

  const handlePrint = async () => {
    setBusy('print')
    try {
      const html = await apiFetchText(`/api/mobile/pharmacy/sales/${saleId}/receipt.pdf`, { token })
      await Print.printAsync({ html })
      // Dismissing the OS print sheet is not evidence that paper came out.
      const recorded = await reportPrintOutcome('requested')
      if (!recorded) {
        Alert.alert(
          'Print status not recorded',
          'The receipt was sent to the print sheet, but this device could not record the attempt. The sale is unchanged.',
        )
      }
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : 'printer unavailable'
      const recorded = await reportPrintOutcome('failed', reason)
      Alert.alert(
        'Receipt not printed',
        `${printerUnavailableNote}${recorded ? '' : '\n\nThis failure could not be recorded — tell your supervisor.'}`,
      )
    } finally {
      setBusy(null)
    }
  }

  const reportPrinterUnavailable = async (): Promise<boolean> => {
    setBusy('unavailable')
    try {
      return await reportPrintOutcome('failed', 'cashier reported no printer')
    } finally {
      setBusy(null)
    }
  }

  const recordPrinterUnavailable = async () => {
    const recorded = await reportPrinterUnavailable()
    if (!recorded) {
      Alert.alert(
        'Not recorded',
        'This device could not reach the server. Tell your supervisor that the receipt was not printed.',
      )
    }
  }

  /**
   * Leaving is never held on the network: the sale is already committed, and a
   * cashier who cannot reach the server must still be able to close the
   * screen. A failed recording is reported and then they go — the same
   * trade-off the web till makes.
   */
  const leaveAsPrinterUnavailable = async () => {
    const recorded = await reportPrinterUnavailable()
    if (!recorded) {
      Alert.alert(
        'Not recorded',
        'This device could not reach the server. Tell your supervisor that the receipt was not printed.',
        [{ text: 'Leave', onPress: () => router.back() }],
        { cancelable: false },
      )
      return
    }
    router.back()
  }

  // Back cannot dismiss the decision: both exits record a print outcome, and
  // `cancelable: false` stops Android dismissing this prompt either.
  const requestPrintDecision = () => {
    Alert.alert(
      'Receipt print required',
      'This pharmacy requires a print decision before you leave. The sale is already saved either way.',
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Printer unavailable', onPress: () => void leaveAsPrinterUnavailable() },
        { text: 'Print now', onPress: () => void handlePrint() },
      ],
      { cancelable: false },
    )
  }

  const handleBack = () => {
    if (blockExit) {
      requestPrintDecision()
      return
    }
    router.back()
  }

  // The hardware listener must outlive re-renders without re-subscribing on
  // every keystroke, so it reads the latest handler through a ref.
  const backHandler = useRef(handleBack)
  backHandler.current = handleBack

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        backHandler.current()
        return true
      })
      return () => subscription.remove()
    }, []),
  )

  // iOS swipe-back is the third way out; disable it while the decision is owed.
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !blockExit })
  }, [navigation, blockExit])

  useEffect(() => {
    if (loading || !receipt || !token || autoPrintTried.current) return
    if (autoprint !== '1') return
    autoPrintTried.current = true
    void handlePrint()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once after first successful load
  }, [loading, receipt, token, autoprint])

  const handleShare = async () => {
    setBusy('share')
    try {
      const uri = await makePdfUri(false)
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device cannot share files.')
        return
      }
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Share receipt' })
      await logShare('file')
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  const handleEmail = async () => {
    setBusy('email')
    try {
      if (!(await MailComposer.isAvailableAsync())) {
        Alert.alert('Email unavailable', 'No mail account is set up on this device.')
        return
      }
      const uri = await makePdfUri(false)
      await MailComposer.composeAsync({
        subject: `Receipt ${receipt?.receiptNumber ?? ''}`,
        body: 'Please find your receipt attached.',
        attachments: [uri],
      })
      await logShare('email')
    } catch (err) {
      Alert.alert('Email failed', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  const handleRefund = async () => {
    if (!receipt) return
    setRefundReason('')
    setRefundOpen(true)
  }

  const submitRefund = async () => {
    if (!receipt) return
    const reason = refundReason.trim()
    if (!reason) {
      Alert.alert('Refund reason', 'Enter why this sale is being refunded.')
      return
    }
    setBusy('refund')
    try {
      await apiRequest('/api/mobile/pharmacy/refunds', {
        method: 'POST',
        token,
        body: { saleId, reason },
      })
      setRefundOpen(false)
      await load()
      Alert.alert('Refunded', 'The sale was voided and stock restored.')
    } catch (err) {
      Alert.alert('Refund failed', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  const handleReprint = async () => {
    setBusy('reprint')
    try {
      const data = await apiRequest<{ receipt: ReceiptSnapshot }>(
        `/api/mobile/pharmacy/sales/${saleId}/reprint`,
        { method: 'POST', token },
      )
      setReceipt(data.receipt)
      const html = await apiFetchText(`/api/mobile/pharmacy/sales/${saleId}/receipt.pdf?reprint=1`, { token })
      await Print.printAsync({ html })
      // A reprint is a print attempt too; the server records that it was asked
      // for, never that paper came out, and it never creates a new sale.
      const recorded = await reportPrintOutcome('requested')
      if (!recorded) {
        Alert.alert(
          'Reprint status not recorded',
          'The reprint was sent to the print sheet, but this device could not record it. The sale is unchanged.',
        )
      }
    } catch (err) {
      await reportPrintOutcome('failed', 'reprint could not open the print sheet')
      Alert.alert('Reprint failed', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={handleBack} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Receipt</Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading receipt…" />
      ) : !receipt ? (
        <EmptyState title="Receipt not found" body="This sale is not available." icon="document" />
      ) : (
        <>
          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: spacing.xxl }]}>
            <View style={styles.paper}>
              <Text style={styles.shopName}>{receipt.pharmacy.tradingName || receipt.pharmacy.legalName}</Text>
              {receipt.pharmacy.address ? <Text style={styles.muted}>{receipt.pharmacy.address}</Text> : null}
              {receipt.pharmacy.phone ? <Text style={styles.muted}>{receipt.pharmacy.phone}</Text> : null}
              {receipt.pharmacy.tin ? <Text style={styles.muted}>TIN: {receipt.pharmacy.tin}</Text> : null}
              {receipt.pharmacy.ndaLicenseNumber ? (
                <Text style={styles.muted}>NDA: {receipt.pharmacy.ndaLicenseNumber}</Text>
              ) : null}

              <Text style={[styles.docLabel, !receipt.isFiscal && styles.nonFiscal]}>{receipt.documentLabel}</Text>
              {receipt.isReprint ? <Text style={styles.reprint}>*** REPRINT ***</Text> : null}
              {receipt.status !== 'completed' ? (
                <Text style={[styles.reprint, { color: TONE_COLORS.red }]}>*** {receipt.status.toUpperCase()} ***</Text>
              ) : null}

              <View style={styles.divider} />
              <Row k="Receipt" v={receipt.receiptNumber} />
              <Row k="Date" v={receipt.dateTimeKampala} />
              {receipt.branch ? <Row k="Branch" v={receipt.branch} /> : null}
              {receipt.cashier ? <Row k="Served by" v={receipt.cashier} /> : null}
              {receipt.patientName ? <Row k="Customer" v={receipt.patientName} /> : null}
              <View style={styles.divider} />

              {receipt.lines.map((l, i) => (
                <View key={i} style={styles.line}>
                  <Text style={styles.lineName}>
                    {[l.name, l.strength, l.dosageForm].filter(Boolean).join(' ')}
                  </Text>
                  {l.genericName ? <Text style={styles.lineSub}>({l.genericName})</Text> : null}
                  <View style={styles.lineRow}>
                    <Text style={styles.lineQty}>
                      {l.quantity} {l.packageName || l.unit || 'unit'} × {money(l.unitPrice)}
                    </Text>
                    <Text style={styles.lineTotal}>{money(l.lineTotal)}</Text>
                  </View>
                  {l.discount > 0 ? <Text style={styles.lineSub}>Discount −{money(l.discount)}</Text> : null}
                  {(l.batchNumber || l.expiryDate) ? (
                    <Text style={styles.lineSub}>
                      {[l.batchNumber ? `Batch ${l.batchNumber}` : null, l.expiryDate ? `Exp ${l.expiryDate}` : null]
                        .filter(Boolean)
                        .join('  ')}
                    </Text>
                  ) : null}
                </View>
              ))}

              <View style={styles.divider} />
              <Row k="Subtotal" v={money(receipt.subtotal)} />
              {receipt.discountTotal > 0 ? <Row k="Discount" v={`−${money(receipt.discountTotal)}`} /> : null}
              {receipt.tax && receipt.tax.source === 'vat' ? (
                <>
                  {receipt.tax.taxableAmount > 0 ? (
                    <Row k={`Taxable${receipt.tax.ratePct != null ? ` (${receipt.tax.ratePct}%)` : ''}`} v={money(receipt.tax.taxableAmount)} />
                  ) : null}
                  {receipt.taxAmount > 0 ? (
                    <Row k={`VAT${receipt.tax.ratePct != null ? ` (${receipt.tax.ratePct}%)` : ''}`} v={money(receipt.taxAmount)} />
                  ) : null}
                  {receipt.tax.zeroRatedAmount > 0 ? <Row k="Zero-rated" v={money(receipt.tax.zeroRatedAmount)} /> : null}
                  {receipt.tax.exemptAmount > 0 ? <Row k="Exempt" v={money(receipt.tax.exemptAmount)} /> : null}
                </>
              ) : receipt.taxAmount > 0 ? (
                <Row k="Tax/VAT" v={money(receipt.taxAmount)} />
              ) : null}
              <Row k="TOTAL" v={money(receipt.totalAmount)} strong />
              <Row k="Payment" v={receipt.payment.method} />
              {receipt.payment.reference ? <Row k="Ref" v={receipt.payment.reference} /> : null}

              <View style={styles.divider} />
              {receipt.isFiscal ? (
                <Text style={styles.muted}>
                  EFRIS FISCAL DOCUMENT{receipt.fiscal.documentNumber ? ` · ${receipt.fiscal.documentNumber}` : ''}
                </Text>
              ) : (
                <Text style={[styles.muted, styles.nonFiscal]}>Not an EFRIS fiscal receipt</Text>
              )}
              {receipt.pharmacy.supervisingPharmacist ? (
                <Text style={styles.muted}>Pharmacist: {receipt.pharmacy.supervisingPharmacist}</Text>
              ) : null}
              {receipt.pharmacy.receiptFooter ? <Text style={styles.muted}>{receipt.pharmacy.receiptFooter}</Text> : null}
            </View>
          </ScrollView>

          <View style={[styles.actions, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.actionRow}>
              <Button label="Print" onPress={handlePrint} loading={busy === 'print'} style={styles.actionBtn} />
              <Button label="Share" onPress={handleShare} loading={busy === 'share'} style={styles.actionBtn} />
            </View>
            <View style={styles.actionRow}>
              <Button label="Email" onPress={handleEmail} loading={busy === 'email'} variant="ghost" style={styles.actionBtn} />
              <Button label="Reprint" onPress={handleReprint} loading={busy === 'reprint'} variant="ghost" style={styles.actionBtn} />
            </View>

            {requiresPrintDecision && receipt.status === 'completed' ? (
              <View style={styles.printNotice}>
                {printOutcome === null ? (
                  <Text style={styles.printNoticeText}>
                    This pharmacy requires a receipt print. Print now, or record that no printer is
                    available — the sale is already saved either way.
                  </Text>
                ) : printOutcome === 'requested' ? (
                  <Text style={styles.printNoticeText}>
                    Print requested. Check the receipt came out — this app cannot confirm it did.
                  </Text>
                ) : (
                  <Text style={[styles.printNoticeText, styles.printWarn]}>
                    Receipt not printed. {printerUnavailableNote}
                  </Text>
                )}
                {printUnrecorded ? (
                  <Text style={[styles.printNoticeText, styles.printWarn]}>
                    This device could not record the print status. Tell your supervisor.
                  </Text>
                ) : null}
                {printOutcome !== 'requested' ? (
                  <Button
                    label="Printer unavailable"
                    onPress={recordPrinterUnavailable}
                    loading={busy === 'unavailable'}
                    variant="ghost"
                  />
                ) : null}
              </View>
            ) : null}

            {receipt.status === 'completed' ? (
              <Button label="Refund / void sale" onPress={handleRefund} loading={busy === 'refund'} variant="danger" />
            ) : null}
          </View>
        </>
      )}

      <Modal
        visible={refundOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRefundOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setRefundOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              Refund / void sale
            </Text>
            <Text style={styles.sheetMessage}>
              Void {receipt?.receiptNumber} and restock its items? This cannot be undone, and the
              reason is kept on the audit trail.
            </Text>
            <TextInput
              style={styles.sheetInput}
              placeholder="Reason (required)"
              placeholderTextColor={colors.textMuted}
              value={refundReason}
              onChangeText={setRefundReason}
              autoFocus
              maxLength={300}
            />
            <View style={styles.sheetActions}>
              <Button
                label="Cancel"
                onPress={() => setRefundOpen(false)}
                variant="ghost"
                style={styles.sheetActionBtn}
              />
              <Button
                label="Refund"
                onPress={() => void submitRefund()}
                loading={busy === 'refund'}
                disabled={!refundReason.trim()}
                variant="danger"
                style={styles.sheetActionBtn}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text style={[styles.kvKey, strong && styles.kvStrong]}>{k}</Text>
      <Text style={[styles.kvVal, strong && styles.kvStrong]}>{v}</Text>
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
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.lg },
  paper: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'stretch',
  },
  shopName: { ...typography.h3, color: colors.text, textAlign: 'center', fontFamily: 'DMSans_700Bold' },
  muted: { ...typography.caption, color: colors.textMuted, textAlign: 'center', fontFamily: 'DMSans_400Regular' },
  docLabel: {
    ...typography.bodyMedium,
    color: colors.text,
    textAlign: 'center',
    marginTop: spacing.md,
    letterSpacing: 1,
    fontFamily: 'DMSans_700Bold',
  },
  nonFiscal: { color: TONE_COLORS.amber },
  reprint: { ...typography.caption, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  line: { marginBottom: spacing.sm },
  lineName: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium' },
  lineSub: { ...typography.caption, color: colors.textMuted, fontFamily: 'DMSans_400Regular' },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  lineQty: { ...typography.caption, color: colors.textSecondary },
  lineTotal: { ...typography.caption, color: colors.text, fontFamily: 'IBMPlexMono_500Medium' },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  kvKey: { ...typography.bodySm, color: colors.textSecondary },
  kvVal: { ...typography.bodySm, color: colors.text, fontFamily: 'IBMPlexMono_400Regular' },
  kvStrong: { fontFamily: 'DMSans_700Bold', color: colors.text },
  actions: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  printNotice: {
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  printNoticeText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  printWarn: { color: TONE_COLORS.amber },
  actionBtn: { flex: 1 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sheetTitle: {
    ...typography.h3,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  sheetMessage: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  sheetInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  sheetActionBtn: { flex: 1 },
})
