import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { ApiError, fetchTallyPlaybackChunk, fetchTallySession } from '@/lib/api'
import {
  chunksForDay,
  eventsForDay,
  progressThrough,
  stockLineLabel,
  type TallyPlaybackEvent,
  type TallyPlaybackIndex,
} from '@/lib/tally-import'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

const PLAY_INTERVAL_MS = 1500

function amount(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * The cut-over walked by date, from the first entry to the last: the opening,
 * then every voucher and (on a replay) every batch movement, in the order
 * Apply writes them. Everything shown is from the plan the preview saved.
 */
export default function TallyPlaybackScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const params = useLocalSearchParams<{ id?: string }>()
  const sessionId = typeof params.id === 'string' ? params.id : ''

  const [index, setIndex] = useState<TallyPlaybackIndex | null>(null)
  const [currency, setCurrency] = useState('UGX')
  const [company, setCompany] = useState<string | null>(null)
  const [loadingIndex, setLoadingIndex] = useState(true)
  const [dayIndex, setDayIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loadingDay, setLoadingDay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped when a chunk lands, so the day's events are recomputed from the cache.
  const [version, setVersion] = useState(0)
  const cache = useRef(new Map<number, TallyPlaybackEvent[]>())
  const dayList = useRef<FlatList<TallyPlaybackIndex['days'][number]>>(null)

  useEffect(() => {
    if (!token || !sessionId) return
    let active = true
    void (async () => {
      try {
        const session = await fetchTallySession(token, sessionId)
        if (!active) return
        setIndex(session.summary?.playback ?? null)
        setCurrency(session.summary?.currency ?? 'UGX')
        setCompany(session.summary?.company ?? null)
        if (!session.summary?.playback) {
          setError(
            session.summary
              ? 'This cut-over states closing balances only, so it has no dated history to walk through.'
              : 'Preview the export before walking through what it carries.',
          )
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'The import could not be loaded.')
      } finally {
        if (active) setLoadingIndex(false)
      }
    })()
    return () => {
      active = false
    }
  }, [token, sessionId])

  const dayCount = index?.days.length ?? 0

  useEffect(() => {
    if (!index || !token) return
    let active = true
    const missing = chunksForDay(index, dayIndex).filter((chunk) => !cache.current.has(chunk))
    if (missing.length === 0) {
      setLoadingDay(false)
      return
    }
    setLoadingDay(true)
    setError(null)
    void (async () => {
      try {
        for (const chunk of missing) {
          const page = await fetchTallyPlaybackChunk(token, sessionId, chunk)
          cache.current.set(chunk, Array.isArray(page.events) ? page.events : [])
        }
        if (active) setVersion((current) => current + 1)
      } catch (err) {
        if (!active) return
        setPlaying(false)
        setError(
          err instanceof ApiError || err instanceof Error ? err.message : 'This day could not be read.',
        )
      } finally {
        if (active) setLoadingDay(false)
      }
    })()
    return () => {
      active = false
    }
  }, [index, dayIndex, sessionId, token])

  // Playing waits for each day to load before moving on, so nothing is skipped.
  useEffect(() => {
    if (!playing || loadingDay) return
    if (dayIndex >= dayCount - 1) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => {
      setDayIndex((current) => Math.min(current + 1, dayCount - 1))
    }, PLAY_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [playing, loadingDay, dayIndex, dayCount])

  useEffect(() => {
    if (dayCount === 0) return
    dayList.current?.scrollToIndex({ index: dayIndex, viewPosition: 0.5, animated: true })
  }, [dayIndex, dayCount])

  const events = useMemo(
    () => (index ? eventsForDay(index, dayIndex, cache.current) : []),
    // `version` signals the cache holds a chunk it did not before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, dayIndex, version],
  )

  const totals = useMemo(
    () =>
      events.reduce(
        (sum, event) => ({ debit: sum.debit + event.debit, credit: sum.credit + event.credit }),
        { debit: 0, credit: 0 },
      ),
    [events],
  )

  const go = useCallback(
    (position: number) => {
      setPlaying(false)
      setDayIndex(Math.max(0, Math.min(position, dayCount - 1)))
    },
    [dayCount],
  )

  if (loadingIndex) {
    return (
      <ScreenShell title="Playback">
        <LoadingBlock message="Loading the history…" />
      </ScreenShell>
    )
  }

  if (!index || dayCount === 0) {
    return (
      <ScreenShell title="Playback">
        <EmptyState title="Nothing to play back" body={error ?? 'This import has no dated history.'} />
      </ScreenShell>
    )
  }

  const day = index.days[dayIndex]
  const through = progressThrough(index, dayIndex)

  return (
    <ScreenShell title="Playback" scroll={false} contentStyle={styles.shell}>
      <Card style={styles.header}>
        <Text style={[styles.company, { color: colors.text }]}>{company ?? 'Tally history'}</Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>
          {index.eventCount.toLocaleString()} dated entries · {index.firstDate} → {index.lastDate}
          {index.movementCount > 0 ? ` · ${index.movementCount.toLocaleString()} batch movements` : ''}
        </Text>
        <View style={[styles.track, { backgroundColor: colors.borderSubtle }]}>
          <View
            style={[styles.fill, { backgroundColor: colors.primary, width: `${through.ratio * 100}%` }]}
          />
        </View>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Day {dayIndex + 1} of {dayCount} · {through.entries.toLocaleString()} of{' '}
          {index.eventCount.toLocaleString()} entries written so far
        </Text>
        {index.movementCount === 0 ? (
          <Text style={[styles.note, { color: colors.textMuted }]}>
            Batch-level movements are computed only by a full-history replay; each day shows what
            was bought and sold.
          </Text>
        ) : null}

        <View style={styles.controls}>
          <Control icon="play-skip-back" label="First day" onPress={() => go(0)} disabled={dayIndex === 0} />
          <Control
            icon="chevron-back"
            label="Previous day"
            onPress={() => go(dayIndex - 1)}
            disabled={dayIndex === 0}
          />
          <Control
            icon={playing ? 'pause' : 'play'}
            label={playing ? 'Pause' : 'Play'}
            primary
            onPress={() => {
              if (!playing && dayIndex >= dayCount - 1) setDayIndex(0)
              setPlaying((value) => !value)
            }}
          />
          <Control
            icon="chevron-forward"
            label="Next day"
            onPress={() => go(dayIndex + 1)}
            disabled={dayIndex >= dayCount - 1}
          />
          <Control
            icon="play-skip-forward"
            label="Last day"
            onPress={() => go(dayCount - 1)}
            disabled={dayIndex >= dayCount - 1}
          />
        </View>
      </Card>

      <FlatList
        ref={dayList}
        horizontal
        data={index.days}
        keyExtractor={(entry) => entry.date}
        style={styles.days}
        contentContainerStyle={styles.daysContent}
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, position) => ({ length: DAY_WIDTH + spacing.xs, offset: (DAY_WIDTH + spacing.xs) * position, index: position })}
        onScrollToIndexFailed={() => undefined}
        renderItem={({ item, index: position }) => {
          const selected = position === dayIndex
          return (
            <Pressable
              onPress={() => go(position)}
              style={[
                styles.day,
                {
                  backgroundColor: selected ? colors.primary : colors.surface,
                  borderColor: selected ? colors.primary : colors.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${item.date}, ${item.events} entries`}
            >
              <Text style={[styles.dayDate, { color: selected ? colors.primaryForeground : colors.text }]}>
                {item.date.slice(5)}
              </Text>
              <Text style={[styles.dayCount, { color: selected ? colors.primaryForeground : colors.textMuted }]}>
                {item.events}
                {item.movements > 0 ? ` · ${item.movements}mv` : ''}
              </Text>
            </Pressable>
          )
        }}
      />

      <FlatList
        data={events}
        keyExtractor={(event) => event.id}
        style={styles.events}
        contentContainerStyle={styles.eventsContent}
        ListHeaderComponent={
          <View style={styles.dayHeader}>
            <Text style={[styles.dayTitle, { color: colors.text }]}>{day?.date}</Text>
            <Text style={[styles.meta, { color: colors.textMuted }]}>
              {day?.events ?? 0} entr{day?.events === 1 ? 'y' : 'ies'} · Dr {currency} {amount(totals.debit)}{' '}
              · Cr {currency} {amount(totals.credit)}
            </Text>
            {error ? <Text style={[styles.note, { color: colors.error }]}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          loadingDay ? (
            <LoadingBlock message="Loading this day…" />
          ) : (
            <Text style={[styles.note, { color: colors.textMuted }]}>No entries on this day.</Text>
          )
        }
        renderItem={({ item: event }) => (
          <Card style={styles.event}>
            <View style={styles.eventTop}>
              <Text style={[styles.eventKind, { color: colors.primary }]}>
                {event.kind.replace(/_/g, ' ')}
                {event.number ? ` · ${event.number}` : ''}
              </Text>
              {event.movements > 0 ? (
                <Text style={[styles.meta, { color: colors.textMuted }]}>{event.movements} mv</Text>
              ) : null}
            </View>
            <Text style={[styles.eventDescription, { color: colors.text }]}>{event.description}</Text>
            {event.debit > 0 || event.credit > 0 ? (
              <Text style={[styles.meta, { color: colors.textSecondary }]}>
                Dr {amount(event.debit)} · Cr {amount(event.credit)} · {event.lineCount} line
                {event.lineCount === 1 ? '' : 's'}
              </Text>
            ) : null}
            {event.stock.slice(0, 6).map((line, position) => (
              <Text
                key={`${event.id}-${position}`}
                style={[
                  styles.stockLine,
                  {
                    color:
                      line.direction === 'out'
                        ? colors.warning
                        : line.direction === 'in'
                          ? colors.success
                          : colors.textSecondary,
                  },
                ]}
              >
                {stockLineLabel(line)}
              </Text>
            ))}
            {event.stock.length > 6 ? (
              <Text style={[styles.meta, { color: colors.textMuted }]}>
                and {event.stock.length - 6} more stock lines
              </Text>
            ) : null}
          </Card>
        )}
      />
    </ScreenShell>
  )
}

const DAY_WIDTH = 72

function Control({
  icon,
  label,
  onPress,
  disabled,
  primary,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        styles.control,
        {
          backgroundColor: primary ? colors.primary : colors.surface,
          borderColor: primary ? colors.primary : colors.border,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={20} color={primary ? colors.primaryForeground : colors.text} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  shell: { flex: 1, gap: spacing.sm },
  header: { gap: spacing.xs },
  company: { ...typography.h4, fontFamily: 'DMSans_700Bold' },
  meta: { ...typography.caption, lineHeight: 17 },
  note: { ...typography.caption, lineHeight: 17 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', marginTop: spacing.xs },
  fill: { height: 6, borderRadius: 3 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  control: {
    flex: 1,
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  days: { flexGrow: 0 },
  daysContent: { gap: spacing.xs, paddingVertical: spacing.xs },
  day: {
    width: DAY_WIDTH,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  dayDate: { ...typography.caption, fontFamily: 'IBMPlexMono_500Medium' },
  dayCount: { ...typography.caption, fontSize: 11 },
  events: { flex: 1 },
  eventsContent: { gap: spacing.sm, paddingBottom: spacing.xl },
  dayHeader: { gap: 2, marginBottom: spacing.xs },
  dayTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_700Bold' },
  event: { gap: 4 },
  eventTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventKind: { ...typography.caption, fontFamily: 'DMSans_700Bold', textTransform: 'capitalize' },
  eventDescription: { ...typography.bodySm },
  stockLine: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular' },
})
