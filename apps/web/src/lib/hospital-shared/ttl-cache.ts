/**
 * Small per-instance TTL memo for role-level and tenant-level gate answers
 * (capability matrix, module toggles, plan features). These change rarely and
 * are not per-user, so a warm Vercel instance can skip the round trip.
 * User-level state (session, role, tenant) is never cached here.
 *
 * Only `true`/allowed answers are cached, so granting access is visible at
 * once and only a revocation waits for the TTL.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Revocations of role capabilities and module toggles take effect within this window. */
export const HOSPITAL_GATE_TTL_MS = 60_000
