import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays,
  dailyFromHealthConnectAggregates,
  dailyFromOxygenRecords,
  formatMetric,
  grantedMetrics,
  healthConnectPermissions,
  localDay,
  seriesFor,
  sleepWindowStart,
  syncWindow,
  weeklyTrend,
} from './wearables-core'

const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).toISOString()

describe('Health Connect permissions', () => {
  it('requests read-only access for the chosen metrics', () => {
    assert.deepEqual(healthConnectPermissions(['steps', 'sleep_minutes']), [
      { accessType: 'read', recordType: 'Steps' },
      { accessType: 'read', recordType: 'SleepSession' },
    ])
  })

  it('keeps only metrics the user actually granted', () => {
    const granted = [
      { accessType: 'read', recordType: 'Steps' },
      { accessType: 'write', recordType: 'HeartRate' },
    ]
    assert.deepEqual(grantedMetrics(['steps', 'heart_rate'], granted), ['steps'])
  })
})

describe('daily aggregates', () => {
  it('maps steps, heart rate and distance aggregates to local days', () => {
    const steps = dailyFromHealthConnectAggregates('steps', [
      { startTime: at(2026, 11, 17), result: { COUNT_TOTAL: 8123 } },
      { startTime: at(2026, 11, 18), result: { COUNT_TOTAL: 0 } },
    ])
    assert.deepEqual(steps, [{ metric: 'steps', day: '2026-11-17', value: 8123, min: null, max: null, samples: 1 }])

    const hr = dailyFromHealthConnectAggregates('heart_rate', [
      { startTime: at(2026, 11, 17), result: { BPM_AVG: 71.26, BPM_MIN: 52, BPM_MAX: 140, MEASUREMENTS_COUNT: 900 } },
    ])
    assert.deepEqual(hr[0], { metric: 'heart_rate', day: '2026-11-17', value: 71.3, min: 52, max: 140, samples: 900 })

    const distance = dailyFromHealthConnectAggregates('distance_m', [
      { startTime: at(2026, 11, 17), result: { DISTANCE: { inMeters: 5321.4 } } },
    ])
    assert.equal(distance[0].value, 5321.4)
  })

  it('drops empty days instead of drawing zeros', () => {
    assert.deepEqual(
      dailyFromHealthConnectAggregates('weight_kg', [{ startTime: at(2026, 11, 17), result: { WEIGHT_AVG: { inKilograms: 0 } } }]),
      [],
    )
    assert.deepEqual(dailyFromHealthConnectAggregates('steps', [{ startTime: 'garbage', result: { COUNT_TOTAL: 5 } }]), [])
  })

  it('gives a night of sleep to the morning you woke up', () => {
    const sleep = dailyFromHealthConnectAggregates('sleep_minutes', [
      { startTime: at(2026, 11, 16, 18), endTime: at(2026, 11, 17, 18), result: { SLEEP_DURATION_TOTAL: 7.5 * 3600 } },
    ])
    assert.deepEqual(sleep, [{ metric: 'sleep_minutes', day: '2026-11-17', value: 450, min: null, max: null, samples: 1 }])
    assert.equal(sleepWindowStart(at(2026, 11, 17)), at(2026, 11, 16, 18))
  })

  it('averages blood oxygen records per day and ignores impossible values', () => {
    const daily = dailyFromOxygenRecords([
      { time: at(2026, 11, 17, 3), percentage: 96 },
      { time: at(2026, 11, 17, 4), percentage: 98 },
      { time: at(2026, 11, 17, 5), percentage: 140 },
    ])
    assert.deepEqual(daily, [{ metric: 'oxygen_saturation', day: '2026-11-17', value: 97, min: 96, max: 98, samples: 2 }])
  })
})

describe('sync window', () => {
  const now = new Date(2026, 10, 18, 9, 30)

  it('goes back 30 days on the first sync', () => {
    const { startTime, endTime } = syncWindow(null, now)
    assert.equal(startTime, new Date(2026, 9, 20).toISOString())
    assert.equal(endTime, now.toISOString())
  })

  it('re-reads from the day before the last sync', () => {
    assert.equal(syncWindow(new Date(2026, 10, 17, 22).toISOString(), now).startTime, new Date(2026, 10, 16).toISOString())
  })

  it('never reaches further back than the cap', () => {
    assert.equal(syncWindow(new Date(2020, 0, 1).toISOString(), now).startTime, new Date(2026, 9, 20).toISOString())
  })
})

describe('trends', () => {
  const today = '2026-11-18'
  const readings = Array.from({ length: 14 }, (_, i) => ({
    metric: 'steps' as const,
    day: addDays(today, i - 13),
    value: i < 7 ? 5000 : 6000,
  }))

  it('fills a fixed-length series with gaps as null', () => {
    const series = seriesFor([{ metric: 'steps', day: today, value: 10 }], 'steps', 3, today)
    assert.deepEqual(series, [
      { day: '2026-11-16', value: null },
      { day: '2026-11-17', value: null },
      { day: '2026-11-18', value: 10 },
    ])
  })

  it('compares this week to last week', () => {
    assert.deepEqual(weeklyTrend(readings, 'steps', today), {
      average: 6000,
      previousAverage: 5000,
      changePct: 20,
      direction: 'up',
    })
  })

  it('reports no trend without a previous week', () => {
    assert.equal(weeklyTrend(readings.slice(7), 'steps', today).direction, 'none')
    assert.equal(weeklyTrend([], 'steps', today).average, null)
  })

  it('formats sleep and distance for people', () => {
    assert.equal(formatMetric('sleep_minutes', 450), '7h 30m')
    assert.equal(formatMetric('sleep_minutes', 420), '7h')
    assert.equal(formatMetric('distance_m', 5321), '5.3')
    assert.equal(formatMetric('steps', 12345), '12,345')
    assert.equal(formatMetric('heart_rate', null), '—')
  })

  it('uses local calendar days', () => {
    assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  })
})
