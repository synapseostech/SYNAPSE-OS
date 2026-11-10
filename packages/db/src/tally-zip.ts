/**
 * Reading a zipped Tally export package.
 *
 * The customer's package is a zip holding one XML export per month plus the
 * manifest the exporter wrote alongside them. An uploaded zip is untrusted
 * input: an entry name may escape the staging directory, an entry may inflate
 * to gigabytes, and the archive may be truncated mid-download. Everything here
 * is bounded, and each refusal names the entry it refused, so a failed upload
 * says which file was unacceptable instead of "invalid archive".
 *
 * Only the parts of the format a Tally package uses are read: a single-disk
 * archive, stored or deflated entries, no encryption, no ZIP64. Anything else
 * is refused with a code rather than guessed at.
 */

import { inflateRawSync } from "node:zlib"

export const TALLY_ZIP_LIMITS = {
  /** The uploaded package as a whole. */
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 256,
  /** One inflated entry. The largest monthly export here is 23MB. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Every inflated entry together. The whole package is 237MB inflated. */
  maxTotalBytes: 512 * 1024 * 1024,
  /**
   * Inflated-to-stored ratio for one entry. Tally XML deflates about 44:1;
   * anything past this is a decompression bomb rather than an export.
   */
  maxCompressionRatio: 200,
  maxNameBytes: 200,
  /** A directory header can carry a long name; nothing legitimate is near this. */
  maxCommentBytes: 2048,
} as const

export type TallyZipEntry = {
  /** The entry name exactly as the archive stores it, after validation. */
  name: string
  /** Lowercased extension without the dot, or "" when there is none. */
  extension: string
  compressedBytes: number
  uncompressedBytes: number
  crc32: number
  /** Byte offset of the first compressed byte in the archive. */
  dataOffset: number
  method: 0 | 8
}

export type TallyZipArchive = {
  entries: TallyZipEntry[]
  /** The archive's own comment, in case the exporter wrote one. */
  comment: string
}

export class TallyZipError extends Error {
  constructor(readonly code: string, message: string, readonly entry?: string) {
    super(message)
    this.name = "TallyZipError"
  }
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_LOCATOR = 0x07064b50
const EOCD_MIN_BYTES = 22
const MAX_COMMENT_SCAN = 0xffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function tallyZipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16(data: DataView, offset: number): number {
  return data.getUint16(offset, true)
}

function u32(data: DataView, offset: number): number {
  return data.getUint32(offset, true)
}

function decoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: false })
}

/**
 * Rejects a name that could write outside the directory it is extracted into,
 * or that the filesystem would not round-trip.
 */
function assertSafeName(name: string, declaredBytes: number): void {
  if (declaredBytes > TALLY_ZIP_LIMITS.maxNameBytes) {
    throw new TallyZipError(
      "TALLY_ZIP_ENTRY_NAME_TOO_LONG",
      `An entry name is ${declaredBytes} bytes long. Export file names are short; a name this long is not one.`,
    )
  }
  if (name.length === 0) {
    throw new TallyZipError("TALLY_ZIP_UNSAFE_ENTRY", "The archive holds an entry with no name.")
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) {
    throw new TallyZipError(
      "TALLY_ZIP_UNSAFE_ENTRY",
      "An entry name contains a control character.",
      name,
    )
  }
  if (name.includes("\\")) {
    throw new TallyZipError(
      "TALLY_ZIP_UNSAFE_ENTRY",
      `Entry "${name}" uses a backslash separator, which a zip from another system could read as a directory escape. Re-create the package with forward slashes.`,
      name,
    )
  }
  if (name.startsWith("/") || name.startsWith("//")) {
    throw new TallyZipError(
      "TALLY_ZIP_UNSAFE_ENTRY",
      `Entry "${name}" is an absolute path.`,
      name,
    )
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new TallyZipError(
      "TALLY_ZIP_UNSAFE_ENTRY",
      `Entry "${name}" names a drive letter rather than a path inside the package.`,
      name,
    )
  }
  for (const segment of name.split("/")) {
    if (segment === "..") {
      throw new TallyZipError(
        "TALLY_ZIP_UNSAFE_ENTRY",
        `Entry "${name}" climbs out of the package with "..".`,
        name,
      )
    }
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  const slash = name.lastIndexOf("/")
  if (dot <= slash + 1) return ""
  return name.slice(dot + 1).toLowerCase()
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.length < EOCD_MIN_BYTES) {
    throw new TallyZipError(
      "TALLY_ZIP_NOT_ARCHIVE",
      "The file is too short to be a zip archive.",
    )
  }
  const data = view(bytes)
  const floor = Math.max(0, bytes.length - EOCD_MIN_BYTES - MAX_COMMENT_SCAN)
  for (let offset = bytes.length - EOCD_MIN_BYTES; offset >= floor; offset -= 1) {
    if (u32(data, offset) !== EOCD_SIGNATURE) continue
    const commentLength = u16(data, offset + 20)
    if (offset + EOCD_MIN_BYTES + commentLength === bytes.length) return offset
  }
  throw new TallyZipError(
    "TALLY_ZIP_NOT_ARCHIVE",
    "No zip directory was found. The file may be truncated, or it may not be a zip archive.",
  )
}

/** Reads the archive's directory. Nothing is inflated here. */
export function readTallyZipDirectory(bytes: Uint8Array): TallyZipArchive {
  if (bytes.byteLength > TALLY_ZIP_LIMITS.maxBytes) {
    throw new TallyZipError(
      "TALLY_ZIP_TOO_LARGE",
      `The package is ${bytes.byteLength} bytes. The limit is ${TALLY_ZIP_LIMITS.maxBytes}. Export fewer months at a time.`,
    )
  }
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new TallyZipError("TALLY_ZIP_NOT_ARCHIVE", "The file does not start with a zip signature.")
  }

  const eocd = findEndOfCentralDirectory(bytes)
  const data = view(bytes)

  if (eocd >= 20 && u32(data, eocd - 20) === ZIP64_EOCD_LOCATOR) {
    throw new TallyZipError(
      "TALLY_ZIP_ZIP64_UNSUPPORTED",
      "The package uses ZIP64, which this importer does not read. A Tally export of this size does not need it; re-zip the folder without ZIP64.",
    )
  }

  const diskNumber = u16(data, eocd + 4)
  const directoryDisk = u16(data, eocd + 6)
  const entriesOnDisk = u16(data, eocd + 8)
  const entryCount = u16(data, eocd + 10)
  const directoryBytes = u32(data, eocd + 12)
  const directoryOffset = u32(data, eocd + 16)
  const commentLength = u16(data, eocd + 20)

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new TallyZipError(
      "TALLY_ZIP_SPANNED_UNSUPPORTED",
      "The package spans more than one volume. Copy it to a single file before uploading.",
    )
  }
  if (entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new TallyZipError(
      "TALLY_ZIP_ZIP64_UNSUPPORTED",
      "The package needs ZIP64 to describe its directory, which this importer does not read.",
    )
  }
  if (entryCount > TALLY_ZIP_LIMITS.maxEntries) {
    throw new TallyZipError(
      "TALLY_ZIP_TOO_MANY_ENTRIES",
      `The package holds ${entryCount} entries. The limit is ${TALLY_ZIP_LIMITS.maxEntries}.`,
    )
  }
  if (directoryOffset + directoryBytes > bytes.length) {
    throw new TallyZipError(
      "TALLY_ZIP_CORRUPT",
      "The zip directory runs past the end of the file, so the package is truncated.",
    )
  }

  const entries: TallyZipEntry[] = []
  const seen = new Set<string>()
  let offset = directoryOffset
  let totalBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length) {
      throw new TallyZipError("TALLY_ZIP_CORRUPT", "The zip directory ends early.")
    }
    if (u32(data, offset) !== CENTRAL_SIGNATURE) {
      throw new TallyZipError("TALLY_ZIP_CORRUPT", "The zip directory entry has a bad signature.")
    }
    const flags = u16(data, offset + 8)
    const method = u16(data, offset + 10)
    const crc = u32(data, offset + 16)
    const compressedBytes = u32(data, offset + 20)
    const uncompressedBytes = u32(data, offset + 24)
    const nameLength = u16(data, offset + 28)
    const extraLength = u16(data, offset + 30)
    const entryCommentLength = u16(data, offset + 32)
    const diskStart = u16(data, offset + 34)
    const localOffset = u32(data, offset + 42)
    const nameStart = offset + 46
    if (nameStart + nameLength > bytes.length) {
      throw new TallyZipError("TALLY_ZIP_CORRUPT", "An entry name runs past the end of the file.")
    }
    const name = decoder().decode(bytes.subarray(nameStart, nameStart + nameLength))

    if (entryCommentLength > TALLY_ZIP_LIMITS.maxCommentBytes) {
      throw new TallyZipError(
        "TALLY_ZIP_CORRUPT",
        "An entry carries an implausibly long comment.",
        name,
      )
    }

    offset = nameStart + nameLength + extraLength + entryCommentLength

    assertSafeName(name, nameLength)

    if (diskStart !== 0) {
      throw new TallyZipError(
        "TALLY_ZIP_SPANNED_UNSUPPORTED",
        `Entry "${name}" starts on another volume.`,
        name,
      )
    }
    if (flags & 0x1) {
      throw new TallyZipError(
        "TALLY_ZIP_ENCRYPTED",
        `Entry "${name}" is encrypted. Re-create the package without a password.`,
        name,
      )
    }
    if (method !== 0 && method !== 8) {
      throw new TallyZipError(
        "TALLY_ZIP_UNSUPPORTED_METHOD",
        `Entry "${name}" uses compression method ${method}. Only stored and deflated entries are read.`,
        name,
      )
    }

    // A directory entry ends in "/" and carries no data.
    if (name.endsWith("/")) continue

    if (seen.has(name)) {
      throw new TallyZipError(
        "TALLY_ZIP_DUPLICATE_ENTRY",
        `The package holds "${name}" twice. Two files with one name cannot both be imported.`,
        name,
      )
    }
    seen.add(name)

    if (uncompressedBytes > TALLY_ZIP_LIMITS.maxEntryBytes) {
      throw new TallyZipError(
        "TALLY_ZIP_ENTRY_TOO_LARGE",
        `Entry "${name}" inflates to ${uncompressedBytes} bytes. The limit is ${TALLY_ZIP_LIMITS.maxEntryBytes}.`,
        name,
      )
    }
    if (method === 0 && compressedBytes !== uncompressedBytes) {
      throw new TallyZipError(
        "TALLY_ZIP_CORRUPT",
        `Entry "${name}" is stored but its two sizes disagree.`,
        name,
      )
    }
    if (
      uncompressedBytes > 0 &&
      compressedBytes > 0 &&
      uncompressedBytes / compressedBytes > TALLY_ZIP_LIMITS.maxCompressionRatio
    ) {
      throw new TallyZipError(
        "TALLY_ZIP_BOMB",
        `Entry "${name}" expands ${Math.round(uncompressedBytes / compressedBytes)} times. A Tally export expands about 45 times, so this is refused rather than decompressed.`,
        name,
      )
    }

    totalBytes += uncompressedBytes
    if (totalBytes > TALLY_ZIP_LIMITS.maxTotalBytes) {
      throw new TallyZipError(
        "TALLY_ZIP_TOTAL_TOO_LARGE",
        `The package inflates to more than ${TALLY_ZIP_LIMITS.maxTotalBytes} bytes. Split it into smaller packages.`,
      )
    }

    // The local header repeats the name and extra field, so the data begins
    // past them rather than at a fixed distance from the entry.
    if (localOffset + 30 > bytes.length) {
      throw new TallyZipError("TALLY_ZIP_CORRUPT", `Entry "${name}" starts past the end of the file.`, name)
    }
    if (u32(data, localOffset) !== LOCAL_SIGNATURE) {
      throw new TallyZipError(
        "TALLY_ZIP_CORRUPT",
        `Entry "${name}" has no local header where the directory says it is.`,
        name,
      )
    }
    const localNameLength = u16(data, localOffset + 26)
    const localExtraLength = u16(data, localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedBytes > bytes.length) {
      throw new TallyZipError(
        "TALLY_ZIP_CORRUPT",
        `Entry "${name}" runs past the end of the file, so the package is truncated.`,
        name,
      )
    }

    entries.push({
      name,
      extension: extensionOf(name),
      compressedBytes,
      uncompressedBytes,
      crc32: crc,
      dataOffset,
      method: method as 0 | 8,
    })
  }

  // `offset` must land exactly on the end of the directory, or the archive is
  // describing a directory layout it does not have.
  if (directoryOffset + directoryBytes !== offset) {
    throw new TallyZipError(
      "TALLY_ZIP_CORRUPT",
      "The zip directory has trailing bytes, so it is not the archive's own.",
    )
  }

  const comment =
    commentLength > 0 && eocd + EOCD_MIN_BYTES + commentLength <= bytes.length
      ? decoder().decode(bytes.subarray(eocd + EOCD_MIN_BYTES, eocd + EOCD_MIN_BYTES + commentLength))
      : ""

  return { entries, comment }
}

/**
 * Inflates one entry, bounded by the size the directory declared and checked
 * against the checksum it declared. A mismatch is corruption, not a warning.
 */
export function extractTallyZipEntry(bytes: Uint8Array, entry: TallyZipEntry): Uint8Array {
  const raw = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes)

  let out: Uint8Array
  if (entry.method === 0) {
    out = raw.slice()
  } else {
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedBytes) })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === "ERR_BUFFER_TOO_LARGE") {
        throw new TallyZipError(
          "TALLY_ZIP_BOMB",
          `Entry "${entry.name}" inflated past the size its directory declared, so it was stopped.`,
          entry.name,
        )
      }
      throw new TallyZipError(
        "TALLY_ZIP_CORRUPT",
        `Entry "${entry.name}" could not be decompressed.`,
        entry.name,
      )
    }
  }

  if (out.byteLength !== entry.uncompressedBytes) {
    throw new TallyZipError(
      "TALLY_ZIP_CORRUPT",
      `Entry "${entry.name}" inflated to ${out.byteLength} bytes but its directory declared ${entry.uncompressedBytes}.`,
      entry.name,
    )
  }
  if (tallyZipCrc32(out) !== entry.crc32) {
    throw new TallyZipError(
      "TALLY_ZIP_CORRUPT",
      `Entry "${entry.name}" failed its checksum, so its contents are damaged.`,
      entry.name,
    )
  }
  return out
}
