import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from './auth'
import { getWearableCache, saveWearableCache } from './personal-store'
import { deviceWearableSource } from './wearables'
import { fetchWearables, uploadWearableReadings, type WearableSnapshot } from './wearables-api'

const EMPTY: WearableSnapshot = { consentVersion: '', connections: [], daily: [] }
/** Re-read the watch at most this often from the Today screen. */
const AUTO_SYNC_MS = 30 * 60 * 1000

/**
 * The signed-in person's wearable summaries: last good copy from this phone
 * first (works offline), then the server, then a fresh read of Health Connect
 * when the user has connected it and the last sync is stale.
 */
export function useWearables({ autoSync = false }: { autoSync?: boolean } = {}) {
  const { user, token } = useAuth()
  const userId = user?.id
  const [snapshot, setSnapshot] = useState<WearableSnapshot>(EMPTY)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  const load = useCallback(async (): Promise<WearableSnapshot | null> => {
    if (!userId || !token) return null
    const cached = await getWearableCache<WearableSnapshot>(userId).catch(() => null)
    if (cached) setSnapshot(cached)
    try {
      const fresh = await fetchWearables(token, 30)
      setSnapshot(fresh)
      setError(null)
      await saveWearableCache(userId, fresh).catch(() => {})
      return fresh
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load watch readings.')
      return cached
    }
  }, [userId, token])

  const syncNow = useCallback(
    async (current?: WearableSnapshot | null) => {
      if (!token || busy.current) return
      const source = deviceWearableSource()
      const base = current ?? snapshot
      const connection = base.connections.find((c) => c.provider === source.provider)
      if (!connection) return
      busy.current = true
      setSyncing(true)
      try {
        const status = await source.status()
        if (status.state !== 'available') {
          setError(status.message)
          return
        }
        const metrics = await source.grantedMetrics(connection.scopes)
        const readings = await source.readDaily(metrics, connection.lastSyncedAt)
        await uploadWearableReadings(token, source.provider, readings)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sync failed. Try again.')
      } finally {
        busy.current = false
        setSyncing(false)
      }
    },
    [token, snapshot, load],
  )

  useEffect(() => {
    let active = true
    ;(async () => {
      const fresh = await load()
      if (!active || !autoSync || !fresh) return
      const source = deviceWearableSource()
      const connection = fresh.connections.find((c) => c.provider === source.provider)
      const last = connection?.lastSyncedAt ? new Date(connection.lastSyncedAt).getTime() : 0
      if (connection && Date.now() - last > AUTO_SYNC_MS) await syncNow(fresh)
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, autoSync])

  return { snapshot, setSnapshot, syncing, error, reload: load, syncNow }
}
