import { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Keyboard, Linking, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListRow } from '@/components/ui/ListRow'
import { SearchField } from '@/components/ui/SearchField'
import { SkeletonRow } from '@/components/ui/Skeleton'
import { searchPosProducts } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { PHARMACY_DESTINATIONS, matchDestination, type Destination } from '@/lib/destinations'
import { tapHaptic } from '@/lib/haptics'
import { dashboardKindForRole } from '@/lib/roles'
import { makeStyles, radii, spacing, typography, useTheme } from '@/lib/theme'

type Product = Awaited<ReturnType<typeof searchPosProducts>>['products'][number]

type Row =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'product'; key: string; product: Product }
  | { kind: 'destination'; key: string; item: Destination; tint: string }

const PHARM_PORTAL = 'https://pharm.synapseos.tech/portal/dashboard'

/**
 * One search for the whole app: products (stock on hand and price) and every
 * screen. Opens with the keyboard up; a barcode button scans straight to the
 * product.
 */
export default function SearchScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { token, user } = useAuth()
  const isPharmacy = dashboardKindForRole(user?.role) === 'pharmacy'
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!isPharmacy || !token || debounced.length < 2) {
      setProducts([])
      setSearching(false)
      return
    }
    const mine = ++seq.current
    setSearching(true)
    setFailed(false)
    searchPosProducts(token, debounced)
      .then((res) => {
        if (mine === seq.current) setProducts(res.products ?? [])
      })
      .catch(() => {
        if (mine === seq.current) {
          setProducts([])
          setFailed(true)
        }
      })
      .finally(() => {
        if (mine === seq.current) setSearching(false)
      })
  }, [debounced, isPharmacy, token])

  const tintOf = (t: string) =>
    t === 'teal' ? colors.teal : t === 'gold' ? colors.gold : t === 'info' ? colors.info : t === 'success' ? colors.success : colors.primary

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const q = query.trim()
    if (isPharmacy && q.length >= 2 && products.length > 0) {
      out.push({ kind: 'header', key: 'h-products', title: `Products (${products.length})` })
      for (const p of products.slice(0, 25)) out.push({ kind: 'product', key: `p-${p.id}`, product: p })
    }
    if (isPharmacy) {
      const dests = PHARMACY_DESTINATIONS.flatMap((g) =>
        g.items.filter((i) => matchDestination(i, g, q)).map((item) => ({ item, tint: tintOf(g.tint) })),
      )
      if (dests.length) {
        out.push({ kind: 'header', key: 'h-screens', title: q ? 'Screens' : 'Jump to' })
        for (const d of q ? dests : dests.slice(0, 12)) {
          out.push({ kind: 'destination', key: `d-${d.item.label}`, item: d.item, tint: d.tint })
        }
      }
    }
    return out
    // tintOf only reads colors
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, products, isPharmacy, colors])

  const open = (route: string) => {
    tapHaptic()
    Keyboard.dismiss()
    router.push(route as never)
  }

  const money = (n: number) => Math.round(n).toLocaleString('en-UG')
  const q = query.trim()
  const nothing = q.length >= 2 && !searching && rows.every((r) => r.kind !== 'product' && r.kind !== 'destination')

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <SearchField
          value={query}
          onChangeText={setQuery}
          autoFocus
          placeholder={isPharmacy ? 'Product, SKU, barcode or screen' : 'Search'}
          trailingIcon={isPharmacy ? 'barcode-outline' : undefined}
          trailingLabel="Scan a barcode"
          onTrailingPress={() => open('/barcode-scan')}
          style={styles.field}
        />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, paddingHorizontal: spacing.lg }}
        ListHeaderComponent={
          searching && products.length === 0 ? (
            <View style={styles.loading}>
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : failed ? (
            <Text style={styles.warn}>Could not search products — check the connection. Screens still match below.</Text>
          ) : undefined
        }
        ListEmptyComponent={
          nothing ? (
            <EmptyState
              icon="search"
              title="No matches"
              body={`Nothing matches “${q}”. Try a shorter name, the SKU, or scan the barcode.`}
              actionLabel={isPharmacy ? 'Scan barcode' : undefined}
              onAction={isPharmacy ? () => open('/barcode-scan') : undefined}
            />
          ) : !isPharmacy ? (
            <EmptyState icon="search" title="Search" body="Type to search." />
          ) : undefined
        }
        renderItem={({ item: row }) => {
          if (row.kind === 'header') return <Text style={styles.header}>{row.title}</Text>
          if (row.kind === 'product') {
            const p = row.product
            const onHand = p.sellableQuantity ?? p.quantity
            const out = onHand <= 0
            return (
              <View style={styles.cardRow}>
                <ListRow
                  title={p.name}
                  subtitle={[p.sku, p.barcode].filter(Boolean).join(' · ') || undefined}
                  icon="medkit-outline"
                  iconColor={out ? colors.danger : colors.teal}
                  onPress={() => open(`/stock-item/${p.id}`)}
                  trailing={
                    <View style={styles.productMeta}>
                      <Text style={styles.price}>{money(p.price)}</Text>
                      <Text style={[styles.qty, { color: out ? colors.danger : colors.textSecondary }]}>
                        {out ? 'Out of stock' : `${onHand} on hand`}
                      </Text>
                    </View>
                  }
                  chevron={false}
                />
              </View>
            )
          }
          const d = row.item
          return (
            <View style={styles.cardRow}>
              <ListRow
                title={d.label}
                subtitle={d.subtitle}
                icon={d.icon}
                iconColor={row.tint}
                onPress={() =>
                  d.action === 'web-portal'
                    ? Linking.openURL(PHARM_PORTAL).catch(() => {})
                    : d.route
                      ? open(d.route)
                      : undefined
                }
              />
            </View>
          )
        }}
      />
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  back: { width: 40, height: 48, alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, marginRight: spacing.sm },
  header: { ...typography.label, color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.sm },
  cardRow: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  productMeta: { alignItems: 'flex-end' },
  price: { color: colors.text, fontFamily: 'IBMPlexMono_500Medium', fontSize: 14 },
  qty: { fontSize: 12, fontFamily: 'DMSans_500Medium', marginTop: 2 },
  loading: { gap: spacing.sm, marginTop: spacing.md },
  warn: { ...typography.bodySm, color: colors.warning, marginTop: spacing.md },
}))
