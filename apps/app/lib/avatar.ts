/**
 * Profile pictures: pick (camera or gallery) → crop square → shrink → upload.
 *
 * expo-image-picker and expo-image-manipulator are native modules added after
 * APK 1.3.0. An over-the-air update can reach an older APK, so both load
 * optionally: without the picker the app explains a new APK is needed; without
 * the manipulator the cropped picture is uploaded at the picker's quality.
 */
import * as FileSystem from 'expo-file-system/legacy'
import { apiRequest } from './api'

type PickerModule = typeof import('expo-image-picker')
type ManipulatorModule = typeof import('expo-image-manipulator')

export type AvatarSource = 'camera' | 'library'

export class AvatarError extends Error {
  readonly code: 'unavailable' | 'permission' | 'upload'
  constructor(code: AvatarError['code'], message: string) {
    super(message)
    this.code = code
  }
}

function optional<T>(load: () => T): T | null {
  try {
    return load()
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = () => optional(() => require('expo-image-picker') as PickerModule)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manipulator = () => optional(() => require('expo-image-manipulator') as ManipulatorModule)

/** True when this APK can take or choose a photo. */
export function canPickAvatar(): boolean {
  const p = picker()
  return Boolean(p && typeof p.launchImageLibraryAsync === 'function')
}

/** The final picture edge in pixels: sharp on a 3x screen at 160dp, small on the wire. */
const AVATAR_EDGE = 512

/**
 * Lets the user take or choose a photo and crop it square.
 * Resolves to a local JPEG uri, or null when they cancel.
 */
export async function pickAvatar(source: AvatarSource): Promise<string | null> {
  const p = picker()
  if (!p) {
    throw new AvatarError('unavailable', 'Install the latest Synapse APK to add a profile photo.')
  }
  const permission =
    source === 'camera' ? await p.requestCameraPermissionsAsync() : await p.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    throw new AvatarError(
      'permission',
      source === 'camera'
        ? 'Allow camera access in Settings to take a profile photo.'
        : 'Allow photo access in Settings to choose a profile photo.',
    )
  }
  const options: import('expo-image-picker').ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
    exif: false,
  }
  const result =
    source === 'camera'
      ? await p.launchCameraAsync({ ...options, cameraType: p.CameraType.front })
      : await p.launchImageLibraryAsync(options)
  if (result.canceled || !result.assets?.length) return null
  const asset = result.assets[0]!

  const m = manipulator()
  if (!m) return asset.uri
  try {
    // Centre-crop to a square in case the platform cropper returned a rectangle.
    const w = asset.width || AVATAR_EDGE
    const h = asset.height || AVATAR_EDGE
    const edge = Math.min(w, h)
    const actions: Parameters<ManipulatorModule['manipulateAsync']>[1] = []
    if (w !== h) {
      actions.push({ crop: { originX: Math.round((w - edge) / 2), originY: Math.round((h - edge) / 2), width: edge, height: edge } })
    }
    if (edge > AVATAR_EDGE) actions.push({ resize: { width: AVATAR_EDGE, height: AVATAR_EDGE } })
    const out = await m.manipulateAsync(asset.uri, actions, { compress: 0.82, format: m.SaveFormat.JPEG })
    return out.uri
  } catch {
    return asset.uri
  }
}

/**
 * Uploads a local picture as the profile photo of `userId` (default: the
 * signed-in user) and returns the URL to show.
 */
export async function uploadAvatar(token: string, localUri: string, userId?: string): Promise<string | null> {
  const target = await apiRequest<{ uploadUrl: string; path: string }>('/api/mobile/profile/avatar', {
    method: 'POST',
    token,
    body: { contentType: 'image/jpeg', ...(userId ? { userId } : {}) },
  })
  let status = 0
  try {
    const res = await FileSystem.uploadAsync(target.uploadUrl, localUri, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'content-type': 'image/jpeg', 'x-upsert': 'true' },
    })
    status = res.status
  } catch {
    throw new AvatarError('upload', 'Network error. Check your connection and try again.')
  }
  if (status < 200 || status >= 300) {
    throw new AvatarError(
      'upload',
      status === 413 ? 'That photo is too large. Try another one.' : `Upload failed (${status}). Try again.`,
    )
  }
  const attached = await apiRequest<{ avatarUrl: string | null }>('/api/mobile/profile/avatar', {
    method: 'PUT',
    token,
    body: { path: target.path, ...(userId ? { userId } : {}) },
  })
  return attached.avatarUrl
}

export async function removeAvatar(token: string, userId?: string): Promise<void> {
  const q = userId ? `?userId=${encodeURIComponent(userId)}` : ''
  await apiRequest<{ avatarUrl: null }>(`/api/mobile/profile/avatar${q}`, { method: 'DELETE', token })
}
