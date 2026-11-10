import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  extractTallyZipEntry,
  readTallyZipDirectory,
  TALLY_ZIP_LIMITS,
  TallyZipError,
  tallyZipCrc32,
} from "./tally-zip.ts"

const enc = (value: string) => new TextEncoder().encode(value)

type ZipEntry = {
  name: string
  data?: Uint8Array
  method?: 0 | 8
  flags?: number
  /** Overrides the directory's declaration without changing the bytes. */
  crc?: number
  compressedBytes?: number
  uncompressedBytes?: number
}

/** Writes a single-disk archive with stored entries, plus the overrides a hostile one needs. */
function zip(entries: ZipEntry[], options: { countOverride?: number } = {}): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const data = Buffer.from(entry.data ?? new Uint8Array())
    const method = entry.method ?? 0
    const flags = entry.flags ?? 0
    const compressedBytes = entry.compressedBytes ?? data.length
    const uncompressedBytes = entry.uncompressedBytes ?? data.length
    const crc = entry.crc ?? tallyZipCrc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(compressedBytes, 18)
    local.writeUInt32LE(uncompressedBytes, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(compressedBytes, 20)
    central.writeUInt32LE(uncompressedBytes, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }

  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(options.countOverride ?? entries.length, 8)
  eocd.writeUInt16LE(options.countOverride ?? entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, eocd]))
}

function refusal(bytes: Uint8Array, code: string) {
  assert.throws(
    () => readTallyZipDirectory(bytes),
    (error: unknown) => error instanceof TallyZipError && error.code === code,
  )
}

describe("reading a Tally export zip", () => {
  it("reads a stored entry and extracts exactly its bytes", () => {
    const bytes = zip([{ name: "2025-10-full.xml", data: enc("<ENVELOPE/>") }])
    const archive = readTallyZipDirectory(bytes)

    assert.equal(archive.entries.length, 1)
    assert.equal(archive.entries[0].name, "2025-10-full.xml")
    assert.equal(archive.entries[0].extension, "xml")
    assert.equal(archive.entries[0].method, 0)
    assert.equal(new TextDecoder().decode(extractTallyZipEntry(bytes, archive.entries[0])), "<ENVELOPE/>")
  })

  it("skips a directory entry and keeps the file beside it", () => {
    const bytes = zip([
      { name: "exports/" },
      { name: "exports/2025-10-full.xml", data: enc("<ENVELOPE/>") },
    ])
    const archive = readTallyZipDirectory(bytes)

    assert.deepEqual(archive.entries.map((entry) => entry.name), ["exports/2025-10-full.xml"])
  })

  it("refuses a name that climbs out of the package", () => {
    refusal(zip([{ name: "../secret.xml", data: enc("x") }]), "TALLY_ZIP_UNSAFE_ENTRY")
    refusal(zip([{ name: "exports/../../secret.xml", data: enc("x") }]), "TALLY_ZIP_UNSAFE_ENTRY")
  })

  it("refuses an absolute path or a drive letter", () => {
    refusal(zip([{ name: "/etc/passwd", data: enc("x") }]), "TALLY_ZIP_UNSAFE_ENTRY")
    refusal(zip([{ name: "C:\\exports\\a.xml", data: enc("x") }]), "TALLY_ZIP_UNSAFE_ENTRY")
  })

  it("refuses two entries with one name", () => {
    refusal(
      zip([
        { name: "2025-10-full.xml", data: enc("a") },
        { name: "2025-10-full.xml", data: enc("b") },
      ]),
      "TALLY_ZIP_DUPLICATE_ENTRY",
    )
  })

  it("refuses an encrypted entry", () => {
    refusal(zip([{ name: "a.xml", data: enc("x"), flags: 0x1 }]), "TALLY_ZIP_ENCRYPTED")
  })

  it("refuses a compression method it does not read", () => {
    refusal(zip([{ name: "a.xml", data: enc("x"), method: 12 as 0 }]), "TALLY_ZIP_UNSUPPORTED_METHOD")
  })

  it("refuses an entry that inflates past the declared size limit", () => {
    refusal(
      zip([
        {
          name: "a.xml",
          data: enc("x"),
          method: 8,
          compressedBytes: 1,
          uncompressedBytes: TALLY_ZIP_LIMITS.maxEntryBytes + 1,
        },
      ]),
      "TALLY_ZIP_ENTRY_TOO_LARGE",
    )
  })

  it("refuses an entry whose expansion is a decompression bomb", () => {
    refusal(
      zip([
        {
          name: "a.xml",
          data: enc("x"),
          method: 8,
          compressedBytes: 10,
          uncompressedBytes: 10 * TALLY_ZIP_LIMITS.maxCompressionRatio + 1,
        },
      ]),
      "TALLY_ZIP_BOMB",
    )
  })

  it("refuses a directory that declares more entries than the limit", () => {
    refusal(
      zip([{ name: "a.xml", data: enc("x") }], { countOverride: TALLY_ZIP_LIMITS.maxEntries + 1 }),
      "TALLY_ZIP_TOO_MANY_ENTRIES",
    )
  })

  it("refuses a stored entry whose two sizes disagree", () => {
    refusal(
      zip([{ name: "a.xml", data: enc("abc"), compressedBytes: 2, uncompressedBytes: 3 }]),
      "TALLY_ZIP_CORRUPT",
    )
  })

  it("refuses bytes that are not an archive, and an archive cut short", () => {
    refusal(enc("PK\u0003\u0004 not really a zip"), "TALLY_ZIP_NOT_ARCHIVE")
    const bytes = zip([{ name: "a.xml", data: enc("x") }])
    refusal(bytes.subarray(0, bytes.length - 10), "TALLY_ZIP_NOT_ARCHIVE")
  })

  it("fails extraction on a checksum that does not match the bytes", () => {
    const bytes = zip([{ name: "a.xml", data: enc("abc"), crc: 0 }])
    const entry = readTallyZipDirectory(bytes).entries[0]

    assert.throws(
      () => extractTallyZipEntry(bytes, entry),
      (error: unknown) => error instanceof TallyZipError && error.code === "TALLY_ZIP_CORRUPT",
    )
  })
})
