/**
 * Every pharmacy screen a person can jump to, grouped as in the More tab.
 * Shared by More (grouped menu) and global search (flat, keyword matched).
 */
import type { Ionicons } from '@expo/vector-icons'

type IoniconName = keyof typeof Ionicons.glyphMap

export type Destination = {
  label: string
  subtitle?: string
  icon: IoniconName
  route?: string
  /** Extra words people type for this screen. */
  keywords?: string
  /** Handled by the caller (e.g. opening the web portal). */
  action?: 'web-portal'
}

export type DestinationGroup = {
  title: string
  tint: 'primary' | 'teal' | 'gold' | 'info' | 'success'
  items: Destination[]
}

export const PHARMACY_DESTINATIONS: DestinationGroup[] = [
  {
    title: 'Sales & POS',
    tint: 'primary',
    items: [
      { label: 'Point of sale', subtitle: 'Complete a sale', icon: 'cart-outline', route: '/pos', keywords: 'sell checkout counter till new sale' },
      { label: 'Till / cashier session', subtitle: 'Open, count, and close', icon: 'wallet-outline', route: '/till', keywords: 'cash drawer shift float' },
      { label: 'Receipt printer', subtitle: 'Wi-Fi, Bluetooth or print dialog', icon: 'print-outline', route: '/printer-setup', keywords: 'print thermal bluetooth wifi escpos' },
      { label: 'Sync status', subtitle: 'Pending, failed, needs review', icon: 'cloud-upload-outline', route: '/sync-status', keywords: 'offline queue upload' },
      { label: 'Sales history', subtitle: 'Receipts & lookups', icon: 'cash-outline', route: '/(main)/sales', keywords: 'receipt reprint takings' },
      { label: 'Transactions', subtitle: 'Counter & order history', icon: 'receipt-outline', route: '/transactions' },
      { label: 'Refunds', subtitle: 'Reverse a sale', icon: 'return-down-back-outline', route: '/refunds', keywords: 'return void' },
      { label: 'Reports', subtitle: 'Sales & inventory', icon: 'bar-chart-outline', route: '/reports', keywords: 'takings profit today summary' },
    ],
  },
  {
    title: 'Inventory',
    tint: 'teal',
    items: [
      { label: 'Inventory', subtitle: 'Stock on hand', icon: 'cube-outline', route: '/(main)/stock', keywords: 'stock check quantity products' },
      { label: 'Receive stock (GRN)', subtitle: 'Batch + expiry', icon: 'download-outline', route: '/receive-stock', keywords: 'grn delivery goods received' },
      { label: 'Quick receive', subtitle: 'Scan, quantity, batch, expiry', icon: 'scan-outline', route: '/quick-receive', keywords: 'delivery scan receive fast' },
      { label: 'Stock take', subtitle: 'Count with your team, then post', icon: 'clipboard-outline', route: '/stock-take', keywords: 'physical count stocktake inventory count variance' },
      { label: 'Stock transfers', subtitle: 'Ship and receive between stores', icon: 'swap-horizontal-outline', route: '/transfers', keywords: 'branch move' },
      { label: 'Stock import', subtitle: 'CSV / Excel', icon: 'cloud-upload-outline', route: '/stock-import', keywords: 'spreadsheet upload' },
      { label: 'Tally import', subtitle: 'Full accounting cut-over', icon: 'document-attach-outline', route: '/tally-import', keywords: 'migration xml' },
      { label: 'Import assistant', subtitle: 'Migration history', icon: 'cloud-done-outline', route: '/import-assistant' },
      { label: 'Barcode lookup', subtitle: 'Scan or type', icon: 'barcode-outline', route: '/barcode-scan', keywords: 'scan camera' },
    ],
  },
  {
    title: 'Purchasing & orders',
    tint: 'gold',
    items: [
      { label: 'Purchases', subtitle: 'Walk-in receive + history', icon: 'cart-outline', route: '/(main)/purchases', keywords: 'buy supplier invoice' },
      { label: 'Orders', subtitle: 'Customer / counter orders', icon: 'bag-handle-outline', route: '/(main)/orders', keywords: 'online' },
      { label: 'Purchase orders', subtitle: 'Supplier POs', icon: 'clipboard-outline', route: '/(main)/purchase-orders', keywords: 'po' },
      { label: 'Suppliers', subtitle: 'Vendor directory', icon: 'business-outline', route: '/suppliers', keywords: 'vendor' },
    ],
  },
  {
    title: 'Customers & finance',
    tint: 'info',
    items: [
      { label: 'Customers', subtitle: 'Directory & accounts', icon: 'people-circle-outline', route: '/customers', keywords: 'patients clients' },
      { label: 'Credit ledger', subtitle: 'Balances & repayments', icon: 'book-outline', route: '/credit-ledger', keywords: 'debt owe' },
      { label: 'Accounting', subtitle: 'Trial balance & journals', icon: 'calculator-outline', route: '/accounting', keywords: 'ledger day book journal' },
    ],
  },
  {
    title: 'Admin',
    tint: 'success',
    items: [
      { label: 'Staff directory', subtitle: 'Faces, roles and status', icon: 'id-card-outline', route: '/(main)/pharmacy-users', keywords: 'team photo people' },
      { label: 'Staff & users', subtitle: 'Roles & temp passwords', icon: 'people-outline', route: '/users', keywords: 'invite password role' },
      { label: 'Pharmacy settings', subtitle: 'Receipt & printer', icon: 'settings-outline', route: '/settings', keywords: 'printer receipt tax' },
      { label: 'Branches', subtitle: 'Sites & satellites', icon: 'business-outline', route: '/branches' },
      { label: 'Activity log', subtitle: 'Audit trail', icon: 'list-outline', route: '/activity-log', keywords: 'audit' },
      { label: 'Billing & subscription', subtitle: 'Plan status', icon: 'card-outline', route: '/billing', keywords: 'pay plan' },
      { label: 'Open web portal', subtitle: 'Full desktop workspace', icon: 'globe-outline', action: 'web-portal' },
    ],
  },
]

/** Case-insensitive match on label, subtitle, keywords and group title. */
export function matchDestination(item: Destination, group: DestinationGroup, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = `${item.label} ${item.subtitle ?? ''} ${item.keywords ?? ''} ${group.title}`.toLowerCase()
  return q.split(/\s+/).every((word) => hay.includes(word))
}
