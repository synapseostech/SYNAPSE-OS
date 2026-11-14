import type { ImportTarget } from "./import-classify"

/**
 * Files chosen on the Import landing page, carried to the workspace that
 * imported them.
 *
 * The landing page navigates with `router.push`, which keeps the running JS
 * runtime, so a module-level store survives the move and a File never has to
 * be read, encoded or uploaded twice. It is deliberately short-lived and
 * one-shot: a refresh loses it, and both workspaces still accept files
 * directly.
 */
const TTL_MS = 2 * 60 * 1000

const pending = new Map<ImportTarget, { files: File[]; at: number }>()

export function putImportHandoff(target: ImportTarget, files: File[]): void {
  if (files.length === 0) {
    pending.delete(target)
    return
  }
  pending.set(target, { files: [...files], at: Date.now() })
}

export function takeImportHandoff(target: ImportTarget): File[] {
  const entry = pending.get(target)
  pending.delete(target)
  if (!entry) return []
  if (Date.now() - entry.at > TTL_MS) return []
  return entry.files
}
