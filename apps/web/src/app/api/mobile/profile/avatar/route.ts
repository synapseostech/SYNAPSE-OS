import { NextRequest, NextResponse } from 'next/server'
import { isAccountActivated, resolveSessionScope, validateSession, verifyToken, withMembershipSuspension } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { isMobilePharmacyAdmin } from '../../../../../lib/mobile-pharmacy-auth'
import {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  avatarExtension,
  avatarFolder,
  isAvatarPathIn,
  newAvatarPath,
  signAvatarUrls,
  type AvatarStorageClient,
} from '../../../../../lib/profile-avatars'

export const dynamic = 'force-dynamic'

/*
 * Profile pictures for the Synapse app.
 *
 *   POST   { contentType, userId? }  → { uploadUrl, path }   sign a one-time upload
 *   PUT    { path, userId? }         → { avatarUrl }          attach the uploaded picture
 *   DELETE ?userId=                  → { avatarUrl: null }    remove the picture
 *
 * Without userId the caller edits their own picture. With it, a pharmacy admin
 * edits a staff member of the pharmacy their session is scoped to. Every path
 * is derived here from the target's own tenant and id; the client never picks
 * where an object goes or which object a profile points at.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any
const storage = () => supabaseAdmin as unknown as AvatarStorageClient

type Session = { userId: string; role: string; tenantId: string }
type Target = { id: string; tenantId: string | null; avatarPath: string | null }

async function requireSession(req: NextRequest): Promise<Session | NextResponse> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const { valid } = await validateSession(token)
  if (!valid) return NextResponse.json({ error: 'Session expired' }, { status: 401 })

  const { data: profile } = await db()
    .from('profiles')
    .select('id, role, tenant_id, verification_status, email_verified_at, is_deleted')
    .eq('id', payload.sub)
    .maybeSingle()
  if (!profile || !isAccountActivated(await withMembershipSuspension(profile))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tokenTenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id.trim() : ''
  const scope = await resolveSessionScope(
    { id: String(profile.id), role: (profile.role as string | null) ?? '', tenant_id: profile.tenant_id as string | null },
    tokenTenantId,
  )
  if (!scope) return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  return { userId: String(profile.id), role: scope.role, tenantId: scope.tenantId ?? '' }
}

/** Resolves whose picture this request changes, refusing anyone the caller may not edit. */
async function resolveTarget(session: Session, requested: unknown): Promise<Target | NextResponse> {
  const targetId = typeof requested === 'string' && requested.trim() ? requested.trim() : session.userId
  if (targetId !== session.userId) {
    if (!session.tenantId || !isMobilePharmacyAdmin({ ...session, token: '' })) {
      return NextResponse.json({ error: 'Only a pharmacy admin can change another person’s photo' }, { status: 403 })
    }
    const { data: member } = await db()
      .from('pharmacy_user_settings')
      .select('profile_id')
      .eq('tenant_id', session.tenantId)
      .eq('profile_id', targetId)
      .maybeSingle()
    if (!member) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }
  const { data: profile } = await db()
    .from('profiles')
    .select('id, tenant_id, avatar_path')
    .eq('id', targetId)
    .maybeSingle()
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  return {
    id: String(profile.id),
    tenantId: (profile.tenant_id as string | null) ?? null,
    avatarPath: (profile.avatar_path as string | null) ?? null,
  }
}

function folderOr400(target: Target): string | NextResponse {
  try {
    return avatarFolder(target.tenantId, target.id)
  } catch {
    return NextResponse.json({ error: 'This account cannot hold a photo' }, { status: 400 })
  }
}

async function audit(session: Session, target: Target, action: string) {
  if (!session.tenantId || target.id === session.userId) return
  try {
    await db().from('pharmacy_audit_logs').insert({
      tenant_id: session.tenantId,
      profile_id: session.userId,
      action,
      entity: 'USER',
      entity_id: target.id,
      details: { source: 'mobile' },
    })
  } catch {
    /* non-fatal */
  }
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req)
  if (session instanceof NextResponse) return session
  const body = (await req.json().catch(() => ({}))) as { contentType?: string; userId?: string }

  const ext = avatarExtension(body.contentType ?? 'image/jpeg')
  if (!ext) return NextResponse.json({ error: 'Use a JPEG, PNG or WebP image' }, { status: 400 })

  const target = await resolveTarget(session, body.userId)
  if (target instanceof NextResponse) return target
  const folder = folderOr400(target)
  if (folder instanceof NextResponse) return folder

  const path = newAvatarPath(folder, ext)
  const { data, error } = await storage().storage.from(AVATAR_BUCKET).createSignedUploadUrl(path)
  if (error || !data?.signedUrl) {
    console.error('[mobile/profile/avatar] sign upload', error?.message)
    return NextResponse.json({ error: 'Photo upload is not available right now' }, { status: 503 })
  }
  return NextResponse.json({ uploadUrl: data.signedUrl, path, maxBytes: AVATAR_MAX_BYTES })
}

export async function PUT(req: NextRequest) {
  const session = await requireSession(req)
  if (session instanceof NextResponse) return session
  const body = (await req.json().catch(() => ({}))) as { path?: unknown; userId?: string }

  const target = await resolveTarget(session, body.userId)
  if (target instanceof NextResponse) return target
  const folder = folderOr400(target)
  if (folder instanceof NextResponse) return folder
  if (!isAvatarPathIn(folder, body.path)) {
    return NextResponse.json({ error: 'That upload does not belong to this profile' }, { status: 400 })
  }
  const path = body.path

  // The object must really be there (the bucket enforces size and type).
  const fileName = path.slice(folder.length + 1)
  const { data: listed } = await storage().storage.from(AVATAR_BUCKET).list(folder, { search: fileName, limit: 5 })
  if (!listed?.some((o) => o.name === fileName)) {
    return NextResponse.json({ error: 'The photo did not finish uploading. Try again.' }, { status: 409 })
  }

  const now = new Date().toISOString()
  const { error } = await db()
    .from('profiles')
    .update({ avatar_path: path, avatar_updated_at: now, updated_at: now })
    .eq('id', target.id)
  if (error) {
    console.error('[mobile/profile/avatar] attach', error.message)
    return NextResponse.json({ error: 'Could not save the photo' }, { status: 500 })
  }

  // Older pictures of this profile are no longer referenced.
  const { data: all } = await storage().storage.from(AVATAR_BUCKET).list(folder, { limit: 100 })
  const stale = (all ?? []).map((o) => `${folder}/${o.name}`).filter((p) => p !== path)
  if (stale.length) await storage().storage.from(AVATAR_BUCKET).remove(stale).then(undefined, () => undefined)

  await audit(session, target, 'UPDATE_USER_PHOTO')
  const signed = await signAvatarUrls(storage(), [path])
  return NextResponse.json({ avatarUrl: signed.get(path) ?? null })
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession(req)
  if (session instanceof NextResponse) return session
  const target = await resolveTarget(session, req.nextUrl.searchParams.get('userId'))
  if (target instanceof NextResponse) return target
  const folder = folderOr400(target)
  if (folder instanceof NextResponse) return folder

  const now = new Date().toISOString()
  const { error } = await db()
    .from('profiles')
    .update({ avatar_path: null, avatar_updated_at: now, updated_at: now })
    .eq('id', target.id)
  if (error) return NextResponse.json({ error: 'Could not remove the photo' }, { status: 500 })

  const { data: all } = await storage().storage.from(AVATAR_BUCKET).list(folder, { limit: 100 })
  const paths = (all ?? []).map((o) => `${folder}/${o.name}`)
  if (paths.length) await storage().storage.from(AVATAR_BUCKET).remove(paths).then(undefined, () => undefined)

  await audit(session, target, 'REMOVE_USER_PHOTO')
  return NextResponse.json({ avatarUrl: null })
}
