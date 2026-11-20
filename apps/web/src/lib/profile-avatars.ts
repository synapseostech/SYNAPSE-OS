/**
 * Profile pictures in the private `profile-avatars` bucket
 * (supabase/migrations/20261120120000_profile_avatars.sql).
 *
 * Objects live at <tenant id | 'personal'>/<profile id>/<epoch ms>.<ext>. The
 * app uploads straight to Storage with a URL this server signs for exactly one
 * such path, and reads pictures through short-lived signed URLs, so the bucket
 * stays private and no request body ever carries image bytes.
 */

export const AVATAR_BUCKET = 'profile-avatars'
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
/** Long enough for a working day's cache, short enough that a removed photo stops resolving. */
export const AVATAR_READ_TTL_SECONDS = 60 * 60 * 24

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TENANT_SEGMENT = /^[0-9a-z-]{1,64}$/
const EXT: Record<string, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export type AvatarStorageClient = {
  storage: {
    from: (bucket: string) => {
      createSignedUploadUrl: (
        path: string,
        options?: Record<string, unknown>,
      ) => PromiseLike<{ data: { signedUrl?: string; token?: string; path?: string } | null; error: { message: string } | null }>
      createSignedUrls: (
        paths: string[],
        expiresIn: number,
      ) => PromiseLike<{ data: Array<{ path: string | null; signedUrl: string | null; error: string | null }> | null; error: { message: string } | null }>
      list: (
        prefix: string,
        options?: Record<string, unknown>,
      ) => PromiseLike<{ data: Array<{ name: string; metadata?: { size?: number; mimetype?: string } | null }> | null; error: { message: string } | null }>
      remove: (paths: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    }
  }
}

export function avatarExtension(contentType: string | null | undefined): 'jpg' | 'png' | 'webp' | null {
  return EXT[String(contentType ?? '').toLowerCase()] ?? null
}

/** The folder every picture of this profile lives in. Throws on anything that is not a clean id. */
export function avatarFolder(profileTenantId: string | null | undefined, profileId: string): string {
  const tenant = profileTenantId ? String(profileTenantId).toLowerCase() : 'personal'
  if (!TENANT_SEGMENT.test(tenant)) throw new Error('AVATAR_TENANT_INVALID')
  if (!UUID.test(profileId.toLowerCase())) throw new Error('AVATAR_PROFILE_INVALID')
  return `${tenant}/${profileId.toLowerCase()}`
}

export function newAvatarPath(folder: string, ext: 'jpg' | 'png' | 'webp', now = Date.now()): string {
  return `${folder}/${now}.${ext}`
}

/**
 * True when `path` is a picture object directly inside `folder` — the only
 * paths a caller may attach to the profile that owns that folder.
 */
export function isAvatarPathIn(folder: string, path: unknown): path is string {
  if (typeof path !== 'string') return false
  if (!path.startsWith(`${folder}/`)) return false
  return /^[0-9]{10,16}\.(jpg|png|webp)$/.test(path.slice(folder.length + 1))
}

/** Signs read URLs for many profiles at once. Unknown or failed paths are simply absent. */
export async function signAvatarUrls(
  db: AvatarStorageClient,
  paths: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0))]
  const out = new Map<string, string>()
  if (wanted.length === 0) return out
  try {
    const { data, error } = await db.storage.from(AVATAR_BUCKET).createSignedUrls(wanted, AVATAR_READ_TTL_SECONDS)
    if (error || !data) return out
    for (const row of data) {
      if (row.path && row.signedUrl && !row.error) out.set(row.path, row.signedUrl)
    }
  } catch {
    /* a missing bucket must not break the profile or staff list */
  }
  return out
}

/**
 * The URL the app should show for a profile: a signed Storage URL when a
 * picture was uploaded, else an external https avatar_url set elsewhere.
 */
export function avatarUrlFor(
  profile: { avatar_path?: string | null; avatar_url?: string | null },
  signed: Map<string, string>,
): string | null {
  if (profile.avatar_path) {
    const url = signed.get(profile.avatar_path)
    if (url) return url
  }
  const external = profile.avatar_url
  return typeof external === 'string' && /^https:\/\//.test(external) ? external : null
}

/**
 * Reads avatar columns for some profiles in their own query, so a database
 * without the avatar migration yet (or any read error) yields no pictures
 * instead of failing the sign-in or staff list that asked for them.
 */
export async function loadProfileAvatars(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  profileIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(profileIds.filter(Boolean))]
  if (ids.length === 0) return out
  try {
    const { data, error } = await admin.from('profiles').select('id, avatar_path, avatar_url').in('id', ids)
    if (error || !Array.isArray(data)) return out
    const signed = await signAvatarUrls(admin as AvatarStorageClient, data.map((r: { avatar_path?: string | null }) => r.avatar_path))
    for (const row of data as Array<{ id: string; avatar_path?: string | null; avatar_url?: string | null }>) {
      const url = avatarUrlFor(row, signed)
      if (url) out.set(String(row.id), url)
    }
  } catch {
    /* pictures are optional */
  }
  return out
}
