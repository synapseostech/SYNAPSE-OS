import Constants from 'expo-constants'
import * as FileSystem from 'expo-file-system'

/** Apex redirects POST to www; Android fetch often drops the body on that redirect. */
function resolveApiBaseUrl(): string {
  const raw = (
    (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
  ).replace(/\/$/, '')
  try {
    const url = new URL(raw)
    if (url.hostname === 'synapseos.tech') {
      url.hostname = 'www.synapseos.tech'
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return 'https://www.synapseos.tech'
  }
}

const BASE_URL = resolveApiBaseUrl()

/** Pharmacy portal origin. Workspace registration is provisioned there, not on the web app. */
function resolvePharmacyBaseUrl(): string {
  const raw = (
    (Constants.expoConfig?.extra?.pharmacyAppUrl as string | undefined) ??
    'https://pharm.synapseos.tech'
  ).replace(/\/$/, '')
  try {
    return new URL(raw).toString().replace(/\/$/, '')
  } catch {
    return 'https://pharm.synapseos.tech'
  }
}

const PHARMACY_BASE_URL = resolvePharmacyBaseUrl()

/** Absolute API base URL (e.g. for building document/print URLs). */
export function apiBaseUrl(): string {
  return BASE_URL
}

const DEFAULT_TIMEOUT_MS = 45_000

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** Non-2xx API response. `status` lets callers branch (401 → re-login,
 * 402 → billing-locked screen) instead of string-matching messages. */
export class ApiError extends Error {
  readonly status: number
  readonly payload: Record<string, unknown>

  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

/** True when the server returned the Workstream C subscription lock (HTTP 402). */
export function isSubscriptionLocked(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 402
}

interface RequestOptions {
  method?: Method
  body?: unknown
  token?: string | null
  timeoutMs?: number
  /** Which Synapse service handles the request. Defaults to the web app. */
  service?: 'web' | 'pharmacy'
}

export async function apiRequest<T>(
  path: string,
  {
    method = 'GET',
    body,
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    service = 'web',
  }: RequestOptions = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-App': 'mobile',
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const baseUrl = service === 'pharmacy' ? PHARMACY_BASE_URL : BASE_URL

  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.')
    }
    throw new Error('Network error. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
  }

  const contentType = res.headers.get('content-type') ?? ''
  const data = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : {}

  if (!res.ok) {
    const payload = data as Record<string, unknown>
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      (typeof payload.error === 'string' && payload.error) ||
      `Request failed (${res.status})`
    throw new ApiError(message, res.status, payload)
  }

  if (!contentType.includes('application/json')) {
    throw new Error('Unexpected server response. Try again in a moment.')
  }

  return data as T
}

/** Fetch a non-JSON (e.g. text/html) endpoint with auth. Used for print-ready receipt HTML. */
export async function apiFetchText(
  path: string,
  { token, timeoutMs = DEFAULT_TIMEOUT_MS }: { token?: string | null; timeoutMs?: number } = {},
): Promise<string> {
  const headers: Record<string, string> = { Accept: 'text/html', 'X-App': 'mobile' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, { method: 'GET', headers, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.')
    }
    throw new Error('Network error. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new ApiError(`Request failed (${res.status})`, res.status)
  }
  return res.text()
}

// ── Pharmacy mobile BFF helpers ──────────────────────────────────────────────

export type PharmacySupplier = {
  id: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  contactPerson: string | null
  notes: string | null
  isActive: boolean
  purchaseOrderCount?: number
}

export type PharmacyPurchaseOrder = {
  id: string
  orderNumber: string
  status: string
  totalAmount: number
  notes: string | null
  expectedDate: string | null
  createdAt: string | null
  supplier: { id: string; name: string; email: string | null; phone: string | null }
  items: Array<{
    id: string
    productId: string | null
    productName: string
    quantity: number
    unitPrice: number
    totalPrice: number
  }>
  createdByName?: string
}

export type PharmacySettings = {
  pharmacyName: string
  receiptHeader: string
  receiptFooter: string
  currency?: string
  lowStockThreshold?: number
  location?: string
  contact?: string
  email?: string
}

export type PharmacyStaffUser = {
  id: string
  name: string
  email: string
  username: string | null
  role: string | null
  isActive: boolean
  createdAt: string | null
}

export function fetchPharmacySuppliers(token: string) {
  return apiRequest<{ suppliers: PharmacySupplier[]; canManage: boolean }>('/api/mobile/pharmacy/suppliers', {
    token,
  })
}

export function createPharmacySupplier(
  token: string,
  body: {
    name: string
    email?: string
    phone?: string
    address?: string
    contactPerson?: string
    notes?: string
  },
) {
  return apiRequest<{ ok: boolean; supplier: PharmacySupplier }>(
    '/api/mobile/pharmacy/suppliers',
    { method: 'POST', token, body },
  )
}

export function fetchPharmacyPurchaseOrders(token: string, supplierId?: string) {
  const q = supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : ''
  return apiRequest<{ purchaseOrders: PharmacyPurchaseOrder[] }>(
    `/api/mobile/pharmacy/purchase-orders${q}`,
    { token },
  )
}

export function createPharmacyPurchaseOrder(
  token: string,
  body: {
    supplierId: string
    items: Array<{ productId?: string; productName: string; quantity: number; unitPrice: number }>
    notes?: string
    expectedDate?: string
  },
) {
  return apiRequest<{ ok: boolean; purchaseOrder: PharmacyPurchaseOrder }>(
    '/api/mobile/pharmacy/purchase-orders',
    { method: 'POST', token, body },
  )
}

export function updatePharmacyPurchaseOrderStatus(
  token: string,
  body: {
    id: string
    status: string
    receiptItems?: Array<{
      productId: string
      batchNumber: string
      expiryDate: string
      quantity?: number
      costPrice?: number
    }>
  },
) {
  return apiRequest<{
    ok: boolean
    purchaseOrder: PharmacyPurchaseOrder | null
    received?: Array<{ productId: string; batchId: string; quantity: number }>
  }>('/api/mobile/pharmacy/purchase-orders', { method: 'PATCH', token, body })
}

export type PharmacyPurchase = {
  id: string
  purchaseNo: string
  status: string
  paymentStatus: string
  paymentMethod: string | null
  supplierInvoiceNo: string | null
  total: number
  amountPaid: number
  balance: number
  purchaseDate: string | null
  receivedDate: string | null
  notes: string | null
  createdAt: string | null
  supplier: { id: string; name: string }
  items: Array<{
    id: string
    productId: string | null
    productName: string
    quantity: number
    unitCost: number
    lineTotal: number
    batchNumber: string | null
    expiryDate: string | null
  }>
}

export function fetchPharmacyPurchases(token: string) {
  return apiRequest<{ purchases: PharmacyPurchase[] }>('/api/mobile/pharmacy/purchases', { token })
}

export function createPharmacyPurchase(
  token: string,
  body: {
    supplierId: string
    supplierInvoiceNo?: string
    idempotencyKey: string
    receiveNow?: boolean
    lines: Array<{
      clientItemId?: string
      productId: string
      productName: string
      quantity: number
      unitCost: number
      batchNumber: string
      expiryDate: string
      sellingPrice?: number | null
      updateSellingPrice?: boolean
    }>
  },
) {
  return apiRequest<{
    ok: boolean
    replay?: boolean
    purchaseId: string
    purchaseNo: string
    status: string
    paymentStatus?: string
    grandTotal?: number
    received: Array<{ productId: string; batchId: string; quantity: number }>
  }>('/api/mobile/pharmacy/purchases', { method: 'POST', token, body })
}

export type PurchaseProductMatch = {
  id: string
  name: string
  sku?: string | null
  barcode?: string | null
  genericName?: string | null
  brandName?: string | null
  strength?: string | null
  dosageForm?: string | null
  manufacturer?: string | null
  price?: number | null
  costPrice?: number | null
  score: number
  existing: true
}

export function searchPurchaseProducts(
  token: string,
  input: { q?: string; barcode?: string; sku?: string },
) {
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.barcode) params.set('barcode', input.barcode)
  if (input.sku) params.set('sku', input.sku)
  return apiRequest<{ matches: PurchaseProductMatch[] }>(
    `/api/mobile/pharmacy/purchases/products?${params.toString()}`,
    { token },
  )
}

export type PurchaseProductDraft = {
  name: string
  genericName?: string
  brand?: string
  strength?: string
  dosageForm?: string
  unit?: string
  barcode?: string
  sku?: string
  manufacturer?: string
  category?: string
  sellingPrice?: number
  reorderLevel?: number
  createAnyway?: boolean
}

export function createPurchaseProduct(token: string, body: PurchaseProductDraft) {
  return apiRequest<{
    ok: boolean
    product: {
      id: string
      name: string
      sku: string | null
      barcode: string | null
      price: number
      costPrice: number | null
      genericName: string | null
      strength: string | null
      dosageForm: string | null
      manufacturer: string | null
    }
  }>('/api/mobile/pharmacy/purchases/products', { method: 'POST', token, body })
}

export function fetchPharmacyReport(
  token: string,
  type: 'sales' | 'inventory' | 'low-stock' | 'expiry' | 'refunds',
  from?: string,
  to?: string,
) {
  const params = new URLSearchParams({ type })
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  return apiRequest<Record<string, unknown>>(`/api/mobile/pharmacy/reports?${params}`, {
    token,
  })
}

export function fetchPharmacySettings(token: string) {
  return apiRequest<{ settings: PharmacySettings }>('/api/mobile/pharmacy/settings', { token })
}

export function patchPharmacySettings(
  token: string,
  body: { pharmacyName?: string; receiptHeader?: string; receiptFooter?: string },
) {
  return apiRequest<{ ok: boolean }>('/api/mobile/pharmacy/settings', {
    method: 'POST',
    token,
    body,
  })
}

export function fetchPharmacyUsers(token: string) {
  return apiRequest<{ users: PharmacyStaffUser[] }>('/api/mobile/pharmacy/users', { token })
}

export function receivePharmacyStockMobile(
  token: string,
  body: {
    productId: string
    batchNumber: string
    quantity: number
    expiryDate: string
    costPrice?: number
    sellingPrice?: number
    supplierId?: string
    reason?: string
  },
) {
  return apiRequest<{
    ok: boolean
    results?: Array<{ productId: string; ok: boolean; batchId?: string; error?: string }>
  }>('/api/mobile/pharmacy/receiving', {
    method: 'POST',
    token,
    body: {
      supplierRef: body.supplierId,
      lines: [
        {
          productId: body.productId,
          batchNumber: body.batchNumber,
          quantity: body.quantity,
          expiryDate: body.expiryDate,
          costPrice: body.costPrice,
        },
      ],
    },
  }).then((res) => {
    const first = res.results?.[0]
    return {
      ok: Boolean(res.ok && first?.ok),
      productId: body.productId,
      batchId: first?.batchId ?? null,
      received: first?.ok ? body.quantity : 0,
      error: first?.error,
    }
  })
}

export function fetchPharmacyRefunds(token: string) {
  return apiRequest<{
    refunds: Array<{
      id: string
      receiptNumber: string
      totalAmount: number
      paymentMethod: string | null
      status: string
      reason: string | null
      voidedAt: string | null
      createdAt: string
    }>
  }>('/api/mobile/pharmacy/refunds', { token })
}

export function postPharmacyRefund(
  token: string,
  body: { saleId: string; reason: string; restoreAs?: 'active' | 'quarantined' },
) {
  return apiRequest<{
    ok: boolean
    saleId: string
    receiptNumber?: string
    refundAmount: number
    restoreAs: string
    status: string
  }>('/api/mobile/pharmacy/refunds', { method: 'POST', token, body })
}

// ── Accounting ──────────────────────────────────────────────────────────────

export type AccountingAccount = {
  id: string
  code: string | null
  name: string | null
  accountType: string | null
  normalBalance: string | null
  systemKey: string | null
  isSystem: boolean
}

export type AccountingBalanceRow = {
  currency: string
  account_id: string
  code: string
  name: string
  account_type: string
  normal_balance: string
  debit: number | string
  credit: number | string
  balance: number | string
}

export type AccountingJournalEntry = {
  id: string
  entryNo: string | null
  entryDate: string | null
  sourceType: string | null
  description: string | null
  currency: string | null
  totalDebit: number
  totalCredit: number
}

export type AccountingOverview = {
  from: string
  to: string
  currency: string
  accounts: AccountingAccount[]
  trialBalance: AccountingBalanceRow[]
  periodActivity: AccountingBalanceRow[]
  recentEntries: AccountingJournalEntry[]
}

export function fetchAccountingOverview(token: string, from: string, to: string) {
  const params = new URLSearchParams({ from, to })
  return apiRequest<AccountingOverview>(
    `/api/mobile/pharmacy/accounting?${params.toString()}`,
    { token },
  )
}

export type ManualVoucherType =
  | 'journal'
  | 'payment'
  | 'receipt'
  | 'contra'
  | 'credit_note'
  | 'debit_note'

export type ManualVoucherLine = {
  accountId: string
  debit: number
  credit: number
  description?: string
}

export function postPharmacyJournal(
  token: string,
  body: {
    voucherType: ManualVoucherType
    entryDate: string
    description: string
    idempotencyKey: string
    lines: ManualVoucherLine[]
  },
) {
  return apiRequest<{
    ok: boolean
    voucherType: ManualVoucherType
    entry: { id?: string; entry_no?: string | number; replayed?: boolean } | null
  }>('/api/mobile/pharmacy/accounting', { method: 'POST', token, body })
}

export type AccountingPeriod = {
  id: string
  periodStart: string | null
  periodEnd: string | null
  status: string | null
  closedAt: string | null
  closeSnapshot: Record<string, unknown> | null
}

export type ReadinessIssue = {
  code: string
  severity: 'blocker' | 'warning'
  message: string
  value?: number
}

export type AccountingCloseReadiness = {
  readiness: {
    ready: boolean
    issues: ReadinessIssue[]
    blockers: ReadinessIssue[]
    warnings: ReadinessIssue[]
  }
  snapshot: Record<string, number | string | null>
}

export function fetchAccountingPeriods(token: string) {
  return apiRequest<{ periods: AccountingPeriod[] }>('/api/mobile/pharmacy/accounting/periods', {
    token,
  })
}

export function fetchAccountingPeriodReadiness(token: string, start: string, end: string) {
  const params = new URLSearchParams({ start, end })
  return apiRequest<AccountingCloseReadiness>(
    `/api/mobile/pharmacy/accounting/periods/readiness?${params.toString()}`,
    { token },
  )
}

export function closeAccountingPeriod(token: string, periodStart: string, periodEnd: string) {
  return apiRequest<{ ok: boolean; period: AccountingPeriod | null }>(
    '/api/mobile/pharmacy/accounting/periods',
    { method: 'POST', token, body: { periodStart, periodEnd } },
  )
}

export type AccountingVoucherKind = ManualVoucherType | 'sales' | 'purchase' | 'other'

export type AccountingDayBookLine = {
  id: string
  accountId: string | null
  accountCode: string
  accountName: string
  debit: number
  credit: number
  description: string
}

export type AccountingDayBookEntry = {
  id: string
  entryNo: string
  date: string
  sourceType: string
  voucherType: AccountingVoucherKind
  voucherLabel: string
  description: string
  currency: string
  totalDebit: number
  totalCredit: number
  lines: AccountingDayBookLine[]
}

export type AccountingDayBook = {
  from: string
  to: string
  page: number
  pageSize: number
  total: number
  entries: AccountingDayBookEntry[]
}

export function fetchAccountingDayBook(
  token: string,
  params: {
    from: string
    to: string
    voucherType?: AccountingVoucherKind
    accountId?: string | null
    page?: number
    pageSize?: number
  },
) {
  const query = new URLSearchParams({ from: params.from, to: params.to })
  if (params.voucherType) query.set('voucherType', params.voucherType)
  if (params.accountId) query.set('accountId', params.accountId)
  if (params.page) query.set('page', String(params.page))
  if (params.pageSize) query.set('pageSize', String(params.pageSize))
  return apiRequest<AccountingDayBook>(
    `/api/mobile/pharmacy/accounting/day-book?${query.toString()}`,
    { token },
  )
}

export type AccountingLedgerLine = {
  id: string
  entryId: string | null
  entryNo: string
  date: string
  sourceType: string
  sourceId: string
  entryDescription: string
  description: string
  debit: number
  credit: number
  balance: number
}

export type AccountingLedger = {
  account: {
    id: string
    code: string
    name: string
    accountType: string
    normalBalance: 'debit' | 'credit'
  }
  currency: string
  currencies: string[]
  from: string
  to: string
  openingBalance: number
  closingBalance: number
  totalDebit: number
  totalCredit: number
  lines: AccountingLedgerLine[]
  truncated: boolean
}

export function fetchAccountingLedger(
  token: string,
  params: { accountId: string; from: string; to: string; currency?: string },
) {
  const query = new URLSearchParams({
    accountId: params.accountId,
    from: params.from,
    to: params.to,
  })
  if (params.currency) query.set('currency', params.currency)
  return apiRequest<AccountingLedger>(
    `/api/mobile/pharmacy/accounting/ledger?${query.toString()}`,
    { token },
  )
}

export type AccountingAgeingBucketId = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'

export type AccountingAgeingRow = {
  partyName: string
  reference: string
  date: string
  dueDate: string | null
  amount: number
  daysOverdue: number
  bucket: AccountingAgeingBucketId
}

export type AccountingAgeingSummary = {
  total: number
  buckets: Record<AccountingAgeingBucketId, number>
  rowCount: number
  truncated: boolean
  rows: AccountingAgeingRow[]
}

export type AccountingAgeing = {
  asOf: string
  allocation: 'oldest-first'
  bucketDefinitions: Array<{ id: AccountingAgeingBucketId; label: string }>
  receivable?: AccountingAgeingSummary & { currency: string; customerCount: number }
  payable?: Array<AccountingAgeingSummary & { currency: string; supplierCount: number }>
}

export function fetchAccountingAgeing(
  token: string,
  params: { asOf: string; side?: 'all' | 'receivable' | 'payable' },
) {
  const query = new URLSearchParams({ asOf: params.asOf })
  if (params.side) query.set('side', params.side)
  return apiRequest<AccountingAgeing>(
    `/api/mobile/pharmacy/accounting/ageing?${query.toString()}`,
    { token },
  )
}

export type BankMatchCandidate = {
  journalLineId: string
  journalEntryId: string
  entryNo: string
  entryDate: string
  description: string
  currency: string
  amount: number
}

export type BankStatementLine = {
  id: string
  importId: string | null
  fileName: string
  lineNumber: number
  date: string
  description: string
  reference: string | null
  currency: string
  amount: number
  matched: boolean
  matchedJournalLineId: string | null
  matchedAt: string | null
  candidates: BankMatchCandidate[]
}

export type BankStatementImportSummary = {
  id: string
  fileName: string
  currency: string
  importedAt: string
}

export type BankReconciliation = {
  page: number
  pageSize: number
  totalLines: number
  matchedOnPage: number
  unmatchedOnPage: number
  imports: BankStatementImportSummary[]
  lines: BankStatementLine[]
}

export type BankStatementImportResult = {
  ok: boolean
  importId: string | null
  replayed: boolean
  rowCount: number
}

export type BankStatementMatchResult = {
  ok: boolean
  match: { replayed?: boolean } | null
}

export function fetchBankReconciliation(token: string, page = 1) {
  const suffix = page > 1 ? `?page=${page}` : ''
  return apiRequest<BankReconciliation>(
    `/api/mobile/pharmacy/accounting/reconciliation${suffix}`,
    { token },
  )
}

/** A pasted statement can hold thousands of rows, so it gets a longer budget. */
export function importBankStatement(
  token: string,
  body: { fileName: string; currency: string; csv: string; idempotencyKey: string },
) {
  return apiRequest<BankStatementImportResult>(
    '/api/mobile/pharmacy/accounting/reconciliation',
    { method: 'POST', token, body, timeoutMs: 120_000 },
  )
}

export function matchBankStatementLine(
  token: string,
  body: { statementLineId: string; journalLineId: string },
) {
  return apiRequest<BankStatementMatchResult>(
    '/api/mobile/pharmacy/accounting/reconciliation',
    { method: 'PATCH', token, body },
  )
}

// ── Tally cut-over ──────────────────────────────────────────────────────────

export type TallyUploadTarget = {
  sessionId: string
  bucket: string
  path: string
  token: string
  signedUrl: string
}

export type TallyPlanSummary = {
  company?: string
  currency: string
  conversionDate: string
  format: 'xml' | 'xlsx' | 'csv'
  counts: {
    ledgers: number
    groups: number
    stockItems: number
    vouchers: number
    postedVouchers: number
    skippedVouchers: number
    sales: number
    purchases: number
    openingLines: number
  }
  opening: { date: string; totalDebit: number; totalCredit: number; difference: number }
  exceptions: Array<{ code: string; message: string; detail?: string; severity: 'blocking' | 'warning' }>
  chunkCount: number
  warnings: string[]
}

export type TallyApplyProgress = {
  stage: 'accounts' | 'parties' | 'products' | 'opening-journal' | 'opening-stock' | 'journals' | 'complete'
  offset: number
  counts: {
    accounts: number
    parties: number
    products: number
    openingJournal: number
    openingStock: number
    journals: number
    sales: number
    purchases: number
  }
  failures: Array<{ stage: string; key: string; code: string; message: string }>
}

export type TallyReconcileCheck = {
  id: string
  label: string
  expected: number | null
  actual: number | null
  difference: number | null
  status: 'ok' | 'difference' | 'not-available'
  note?: string
}

export type TallySession = {
  id: string
  status: string
  fileName: string | null
  errorMessage: string | null
  format: 'xml' | 'xlsx' | 'csv' | null
  conversionDate: string | null
  summary: TallyPlanSummary | null
  reconcile: TallyReconcileCheck[] | null
  progress: TallyApplyProgress | null
  failures: TallyApplyProgress['failures']
  failureCount: number
}

export function createTallyUpload(token: string, body: { fileName: string; fileSize?: number }) {
  return apiRequest<TallyUploadTarget & { error?: string }>('/api/admin/tally/upload-url', {
    method: 'POST',
    token,
    body,
    service: 'pharmacy',
  })
}

/** PUT the picked file straight to Storage; the API never carries the bytes. */
export async function uploadTallySource(signedUrl: string, fileUri: string, contentType: string) {
  const res = await FileSystem.uploadAsync(signedUrl, fileUri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'content-type': contentType, 'x-upsert': 'true' },
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Upload failed (${res.status}). Check your connection and try again.`)
  }
}

export function previewTallyImport(token: string, sessionId: string, conversionDate?: string) {
  return apiRequest<{ summary: TallyPlanSummary }>(
    `/api/admin/tally/${encodeURIComponent(sessionId)}/preview`,
    {
      method: 'POST',
      token,
      body: conversionDate ? { conversionDate } : {},
      service: 'pharmacy',
      timeoutMs: 120_000,
    },
  )
}

export function fetchTallySession(token: string, sessionId: string) {
  return apiRequest<TallySession>(`/api/admin/tally/${encodeURIComponent(sessionId)}`, {
    token,
    service: 'pharmacy',
  })
}

export function applyTallyChunk(token: string, sessionId: string) {
  return apiRequest<{
    done: boolean
    alreadyComplete?: boolean
    progress: TallyApplyProgress
    reconcile: TallyReconcileCheck[] | null
  }>(`/api/admin/tally/${encodeURIComponent(sessionId)}/apply`, {
    method: 'POST',
    token,
    service: 'pharmacy',
    timeoutMs: 120_000,
  })
}

export function deleteTallySession(token: string, sessionId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/admin/tally/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    token,
    service: 'pharmacy',
  })
}

export function searchPosProducts(token: string, q: string) {
  const params = new URLSearchParams({ q, limit: '40' })
  return apiRequest<{
    products: Array<{
      id: string
      name: string
      sku: string | null
      barcode: string | null
      price: number
      costPrice: number | null
      quantity: number
      sellableQuantity?: number
    }>
  }>(`/api/mobile/pharmacy/pos/products?${params}`, { token })
}
