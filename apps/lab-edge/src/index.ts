/**
 * SYNAPSE Lab Edge — LAN gateway for analyzer connectivity.
 *
 * Deploy on a laboratory computer (Linux service / Docker).
 * Cloud Lab never holds a direct serial connection.
 *
 * This package is a Wave 2 scaffold: durable local queue + driver SDK contracts.
 * Protocol drivers (ASTM / HL7 MLLP / serial) plug into AnalyzerDriver.
 */

import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createServer, createConnection, type Server, type Socket } from "node:net"

export const LAB_EDGE_VERSION = "0.2.0-persistent-queue"

export type AnalyzerCapability =
  | "RESULT_UPLOAD"
  | "ORDER_DOWNLOAD"
  | "HOST_QUERY"
  | "QC_UPLOAD"
  | "PATIENT_QUERY"

export type ConnectionType =
  | "SERIAL_RS232"
  | "TCP_CLIENT"
  | "TCP_SERVER"
  | "HL7_MLLP"
  | "ASTM"
  | "FILE_WATCH"
  | "CSV_IMPORT"
  | "REST_HTTP"
  | "VENDOR_API"
  | "MANUAL"

export type NormalizedAnalyzerResult = {
  accessionNumber?: string
  analyzerCode: string
  value: string
  unit?: string
  flags?: Record<string, unknown>
  instrumentFlags?: Record<string, unknown>
  runAt?: string
  rawMessageRef: string
}

/**
 * Drivers parse/produce messages only — they never write clinical results.
 */
export interface AnalyzerDriver {
  identify(): { manufacturer: string; model: string; protocol: string }
  capabilities(): AnalyzerCapability[]
  connect(): Promise<void>
  disconnect(): Promise<void>
  health(): Promise<{ online: boolean; detail: string }>
  parseIncoming(raw: string): Promise<NormalizedAnalyzerResult[]>
  buildOrderMessage?(accession: string, assays: string[]): string
  buildHostQueryResponse?(accession: string, assays: string[]): string
  acknowledge?(ok: boolean): string
}

export interface AnalyzerParser {
  protocol: "ASTM" | "HL7_MLLP" | "CSV" | "REST"
  canParse(frame: string): boolean
  parse(frame: string): NormalizedAnalyzerResult[]
}

export function astmChecksum(payload: string): string {
  let sum = 0
  for (let i = 0; i < payload.length; i += 1) sum = (sum + payload.charCodeAt(i)) % 256
  return sum.toString(16).toUpperCase().padStart(2, "0")
}

export function validateAstmFrame(raw: string): { ok: true } | { ok: false; reason: string } {
  const stx = raw.indexOf("\u0002")
  if (stx < 0) return { ok: true }
  const etx = raw.indexOf("\u0003", stx + 1)
  if (etx < 0) return { ok: false, reason: "ASTM_FRAME_INCOMPLETE" }
  const framed = raw.slice(stx + 1, etx + 1)
  const given = raw.slice(etx + 1).match(/[0-9A-Fa-f]{2}/)?.[0]
  if (!given) return { ok: false, reason: "ASTM_CHECKSUM_MISSING" }
  if (astmChecksum(framed) !== given.toUpperCase()) return { ok: false, reason: "ASTM_CHECKSUM_INVALID" }
  return { ok: true }
}

export const genericAstmParser: AnalyzerParser = {
  protocol: "ASTM",
  canParse(frame) {
    return /(^|\r|\n)[HOPRCL]\|/.test(frame) || frame.includes("\u0002")
  },
  parse(frame) {
    const check = validateAstmFrame(frame)
    if (!check.ok) throw new Error(check.reason)
    return parseAstmResults(frame)
  },
}

export const genericHl7Parser: AnalyzerParser = {
  protocol: "HL7_MLLP",
  canParse(frame) {
    return frame.includes("MSH|") || frame.startsWith("\u000b")
  },
  parse(frame) {
    const unwrapped = unwrapHl7Mllp(frame) ?? frame.replace(/[\u000b\u001c]/g, "")
    if (!unwrapped.includes("MSH|")) throw new Error("HL7_FRAME_INVALID")
    return parseHl7Results(unwrapped)
  },
}

export const genericCsvParser: AnalyzerParser = {
  protocol: "CSV",
  canParse(frame) {
    const header = frame.split(/\r?\n/)[0] ?? ""
    return header.includes(",") && /accession|analyzer|test|code/i.test(header)
  },
  parse(frame) {
    const [headerLine, ...rows] = frame.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const headers = (headerLine ?? "").split(",").map((cell) => cell.trim().toLowerCase())
    const accessionIdx = headers.findIndex((cell) => cell.includes("accession"))
    const codeIdx = headers.findIndex((cell) => /code|test/.test(cell))
    const valueIdx = headers.findIndex((cell) => cell.includes("value"))
    const unitIdx = headers.findIndex((cell) => cell.includes("unit"))
    if (codeIdx < 0 || valueIdx < 0) throw new Error("CSV_HEADER_INVALID")
    return rows.map((row) => {
      const cells = row.split(",").map((cell) => cell.trim())
      return {
        accessionNumber: accessionIdx >= 0 ? cells[accessionIdx] : undefined,
        analyzerCode: cells[codeIdx] ?? "",
        value: cells[valueIdx] ?? "",
        unit: unitIdx >= 0 ? cells[unitIdx] : undefined,
        rawMessageRef: crypto.randomUUID(),
      }
    }).filter((row) => row.analyzerCode && row.value)
  },
}

export const genericRestParser: AnalyzerParser = {
  protocol: "REST",
  canParse(frame) {
    const trimmed = frame.trim()
    return trimmed.startsWith("{") || trimmed.startsWith("[")
  },
  parse(frame) {
    const parsed = JSON.parse(frame) as Record<string, unknown> | Record<string, unknown>[]
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.observations) ? parsed.observations as Record<string, unknown>[] : [parsed]
    return rows.map((row) => ({
      accessionNumber: typeof row.accessionNumber === "string" ? row.accessionNumber : undefined,
      analyzerCode: String(row.analyzerCode ?? row.code ?? ""),
      value: String(row.value ?? ""),
      unit: typeof row.unit === "string" ? row.unit : undefined,
      rawMessageRef: crypto.randomUUID(),
    })).filter((row) => row.analyzerCode && row.value)
  },
}

export type EdgeQueueItem = {
  id: string
  createdAt: string
  payloadHash: string
  rawPayload: string
  protocol: string
  uploaded: boolean
  attempts: number
  state: "RECEIVED" | "QUEUED" | "UPLOADING" | "ACKNOWLEDGED" | "FAILED" | "DEAD_LETTER"
  lastAttemptAt?: string | null
  lastError?: string | null
  cloudMessageId?: string | null
  acknowledgedAt?: string | null
}

export type EdgeServiceState = "STARTING" | "RUNNING" | "DEGRADED" | "OFFLINE" | "STOPPING" | "ERROR"

export type EdgeTransportConfig = {
  host?: string
  port: number
  deviceId: string
  protocol: "ASTM" | "HL7_MLLP"
  frameTimeoutMs?: number
  bridgeId?: string
  heartbeatEndpoint?: string
  heartbeatIntervalMs?: number
}

function cleanField(value: string | undefined): string {
  return (value ?? "").trim()
}

/** Drop everything from the first ASTM FS (0x1c) separator; linear, no regex backtracking. */
function stripAstmFrameTrailer(line: string): string {
  const fs = line.indexOf("\x1c")
  return fs === -1 ? line : line.slice(0, fs)
}

/** Upper bound on one analyzer message; real ASTM transmissions are a few KB. */
export const MAX_ASTM_MESSAGE_CHARS = 1_000_000

/** Parse common ASTM H/P/O/R/L records into staging-safe normalized results. */
export function parseAstmResults(raw: string, rawMessageRef: string = crypto.randomUUID()): NormalizedAnalyzerResult[] {
  const records = raw
    .slice(0, MAX_ASTM_MESSAGE_CHARS)
    .replace(/[\u0002\u0003]/g, "")
    .split(/[\r\n]+/)
    .map((line) => stripAstmFrameTrailer(line.replace(/^\d/, "")).trim())
    .filter(Boolean)
  let accessionNumber: string | undefined
  let runAt: string | undefined
  const results: NormalizedAnalyzerResult[] = []

  for (const record of records) {
    const fields = record.split("|")
    const type = fields[0]?.toUpperCase()
    if (type === "O") {
      accessionNumber = cleanField(fields[2]?.split("^")[0]) || cleanField(fields[3]?.split("^")[0])
    } else if (type === "R") {
      const analyzerCode = cleanField(fields[2]?.split("^").filter(Boolean).pop())
      const value = cleanField(fields[3])
      if (analyzerCode && value) {
        results.push({
          accessionNumber,
          analyzerCode,
          value,
          unit: cleanField(fields[4]) || undefined,
          flags: { abnormal: cleanField(fields[6]) || undefined },
          runAt,
          rawMessageRef,
        })
      }
    } else if (type === "H" && fields[13]) {
      runAt = cleanField(fields[13]) || undefined
    }
  }
  return results
}

/** Parse an HL7 ORU^R01 message after MLLP framing has been removed. */
export function parseHl7Results(raw: string, rawMessageRef: string = crypto.randomUUID()): NormalizedAnalyzerResult[] {
  const segments = raw
    .replace(/[\u000b\u001c]/g, "")
    .split(/[\r\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  let accessionNumber: string | undefined
  let runAt: string | undefined
  const results: NormalizedAnalyzerResult[] = []

  for (const segment of segments) {
    const fields = segment.split("|")
    if (fields[0] === "MSH") runAt = cleanField(fields[6]) || undefined
    if (fields[0] === "OBR") accessionNumber = cleanField(fields[3]?.split("^")[0]) || cleanField(fields[2]?.split("^")[0])
    if (fields[0] === "OBX") {
      const analyzerCode = cleanField(fields[3]?.split("^")[0])
      const value = cleanField(fields[5])
      if (analyzerCode && value) {
        results.push({
          accessionNumber,
          analyzerCode,
          value,
          unit: cleanField(fields[6]) || undefined,
          flags: { abnormal: cleanField(fields[8]) || undefined },
          runAt,
          rawMessageRef,
        })
      }
    }
  }
  return results
}

export function buildAstmCbcSimulatorMessage(accession: string): string {
  return [
    "H|\\^&|||SYNAPSE AST-100^SIMULATOR|||||P|1",
    `P|1||${accession}|||||||||||||||`,
    `O|1|${accession}||^^^WBC\\^^^HGB|R||||||N||||||||||||||F`,
    "R|1|^^^WBC|6.8|10*9/L||||N|||F",
    "R|2|^^^HGB|13.4|g/dL||||N|||F",
    "L|1|N",
  ].join("\r")
}

export function buildHl7ChemistrySimulatorMessage(accession: string): string {
  return [
    "MSH|^~\\&|SYNAPSE-CHEM|LAB|SYNAPSE|CORE|20260904120000||ORU^R01|SIM-1|P|2.5",
    `PID|1||${accession}||GOLDEN^TEST`,
    `OBR|1|${accession}|${accession}||CHEM^Chemistry panel|||20260904120000`,
    "OBX|1|NM|2345-7^Glucose^LN||5.2|mmol/L|3.9-6.1|N|||F",
    "OBX|2|NM|2160-0^Creatinine^LN||82|umol/L|60-110|N|||F",
  ].join("\r")
}

export class EdgeDurableQueue {
  private readonly db: DatabaseSync
  private readonly maxAttempts: number

  constructor(path = ":memory:", maxAttempts = 8) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.maxAttempts = maxAttempts
    this.db.exec(`CREATE TABLE IF NOT EXISTS edge_queue (
      id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL UNIQUE, raw_payload TEXT NOT NULL,
      protocol TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL,
      upload_attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, next_attempt_at TEXT,
      last_error TEXT, cloud_message_id TEXT, acknowledged_at TEXT, updated_at TEXT NOT NULL
    )`)
    this.db.exec("UPDATE edge_queue SET state = 'FAILED', last_error = 'Recovered after interrupted upload', next_attempt_at = NULL, updated_at = ? WHERE state = 'UPLOADING'")
  }

  enqueue(rawPayload: string, protocol: string): EdgeQueueItem {
    const payloadHash = createHash("sha256").update(rawPayload).digest("hex")
    const existing = this.db.prepare("SELECT * FROM edge_queue WHERE payload_hash = ?").get(payloadHash) as Record<string, unknown> | undefined
    if (existing) return this.fromRow(existing)
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    this.db.prepare("INSERT INTO edge_queue (id, payload_hash, raw_payload, protocol, created_at, state, updated_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)").run(id, payloadHash, rawPayload, protocol, now, now)
    return this.get(id)!
  }

  get(id: string): EdgeQueueItem | null {
    const row = this.db.prepare("SELECT * FROM edge_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return row ? this.fromRow(row) : null
  }

  pending(): EdgeQueueItem[] {
    const rows = this.db.prepare("SELECT * FROM edge_queue WHERE state IN ('QUEUED','FAILED','UPLOADING') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at").all(new Date().toISOString()) as Record<string, unknown>[]
    return rows.map((row) => this.fromRow(row))
  }

  markUploading(id: string): EdgeQueueItem | null {
    const now = new Date().toISOString()
    this.db.prepare("UPDATE edge_queue SET state = 'UPLOADING', upload_attempts = upload_attempts + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
    return this.get(id)
  }

  markUploaded(id: string, cloudMessageId?: string | null) {
    const now = new Date().toISOString()
    this.db.prepare("UPDATE edge_queue SET state = 'ACKNOWLEDGED', cloud_message_id = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?").run(cloudMessageId ?? null, now, now, id)
  }

  markFailed(id: string, error: string, permanent = false) {
    const item = this.get(id)
    if (!item) return
    const dead = permanent || item.attempts >= this.maxAttempts
    const delay = Math.min(60 * 60, 2 ** Math.max(0, item.attempts - 1))
    const next = new Date(Date.now() + delay * 1000).toISOString()
    this.db.prepare("UPDATE edge_queue SET state = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(dead ? "DEAD_LETTER" : "FAILED", error, next, new Date().toISOString(), id)
  }

  retry(id: string) {
    this.db.prepare("UPDATE edge_queue SET state = 'QUEUED', next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state IN ('FAILED','DEAD_LETTER')").run(new Date().toISOString(), id)
  }

  counts() {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM edge_queue GROUP BY state").all() as { state: string; count: number }[]
    return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]))
  }

  lastAcknowledgedAt(): string | null {
    const row = this.db.prepare("SELECT acknowledged_at FROM edge_queue WHERE state = 'ACKNOWLEDGED' ORDER BY acknowledged_at DESC LIMIT 1").get() as { acknowledged_at?: string | null } | undefined
    return row?.acknowledged_at ?? null
  }

  lastReceivedAt(): string | null {
    const row = this.db.prepare("SELECT created_at FROM edge_queue ORDER BY created_at DESC LIMIT 1").get() as { created_at?: string | null } | undefined
    return row?.created_at ?? null
  }

  close() { this.db.close() }

  private fromRow(row: Record<string, unknown>): EdgeQueueItem {
    return {
      id: String(row.id), createdAt: String(row.created_at), payloadHash: String(row.payload_hash),
      rawPayload: String(row.raw_payload), protocol: String(row.protocol), uploaded: row.state === "ACKNOWLEDGED",
      attempts: Number(row.upload_attempts ?? 0), state: row.state as EdgeQueueItem["state"],
      lastAttemptAt: row.last_attempt_at as string | null, lastError: row.last_error as string | null,
      cloudMessageId: row.cloud_message_id as string | null, acknowledgedAt: row.acknowledged_at as string | null,
    }
  }
}

export function unwrapHl7Mllp(raw: string): string | null {
  if (!raw.startsWith("\x0b")) return null
  const end = raw.indexOf("\x1c\r", 1)
  if (end < 0) return null
  return raw.slice(1, end)
}

export function frameHl7Mllp(payload: string): string {
  return `\x0b${payload}\x1c\r`
}

export function createEdgeListener(
  queue: EdgeDurableQueue,
  config: EdgeTransportConfig,
  onMessage?: (item: EdgeQueueItem) => void,
): Server {
  const server = createServer((socket: Socket) => {
    let buffer = ""
    const timeout = setTimeout(() => socket.destroy(), config.frameTimeoutMs ?? 30_000)
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const payload = config.protocol === "HL7_MLLP" ? unwrapHl7Mllp(buffer) : buffer.includes("\rL|") || buffer.endsWith("L|1|N") ? buffer : null
      if (payload == null) return
      clearTimeout(timeout)
      const item = queue.enqueue(payload, config.protocol)
      onMessage?.(item)
      if (config.protocol === "HL7_MLLP") socket.write("\x06")
      socket.end()
    })
    socket.on("error", () => socket.destroy())
  })
  return server
}

export class EdgeService {
  state: EdgeServiceState = "STARTING"
  private listener: Server | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSuccessfulUpload: string | null

  constructor(
    readonly queue: EdgeDurableQueue,
    readonly config: EdgeTransportConfig,
    readonly uploadEndpoint: string,
    readonly bridgeKey: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.lastSuccessfulUpload = this.queue.lastAcknowledgedAt()
  }

  async start(): Promise<void> {
    this.state = "STARTING"
    this.listener = createEdgeListener(this.queue, this.config)
    await new Promise<void>((resolve, reject) => {
      this.listener!.once("error", reject)
      this.listener!.listen(this.config.port, this.config.host ?? "127.0.0.1", () => resolve())
    })
    this.timer = setInterval(() => {
      void uploadPending(this.queue, this.uploadEndpoint, this.bridgeKey, this.config.deviceId, this.fetchImpl)
        .then((result) => {
          this.state = result.failed > 0 ? "DEGRADED" : "RUNNING"
          if (result.uploaded > 0) this.lastSuccessfulUpload = new Date().toISOString()
          return this.sendHeartbeat()
        })
        .catch(() => { this.state = "OFFLINE" })
    }, Math.max(1_000, this.config.heartbeatIntervalMs ?? 15_000))
    this.state = "RUNNING"
    await uploadPending(this.queue, this.uploadEndpoint, this.bridgeKey, this.config.deviceId, this.fetchImpl)
    await this.sendHeartbeat()
  }

  private async sendHeartbeat(): Promise<void> {
    const endpoint = this.config.heartbeatEndpoint ?? this.uploadEndpoint.replace(/\/instrument-ingest(?:\/?$)/, "/edge/heartbeat")
    const counts = this.queue.counts()
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": this.bridgeKey },
      body: JSON.stringify({
        bridgeId: this.config.bridgeId,
        deviceId: this.config.deviceId,
        edgeVersion: LAB_EDGE_VERSION,
        serviceState: this.state,
        timestamp: new Date().toISOString(),
        queueDepth: this.queue.pending().length,
        queuedCount: Number(counts.QUEUED ?? 0),
        failedCount: Number(counts.FAILED ?? 0),
        deadLetterCount: Number(counts.DEAD_LETTER ?? 0),
        lastSuccessfulUpload: this.lastSuccessfulUpload,
        deviceIds: [this.config.deviceId],
        edgeIdentity: this.config.bridgeId ?? this.config.deviceId,
        connectionState: this.state,
        lastAnalyzerFrameAt: this.queue.lastReceivedAt(),
        clock: new Date().toISOString(),
      }),
    })
    if (!response.ok) throw new Error(`heartbeat_failed_${response.status}`)
  }

  async stop(): Promise<void> {
    this.state = "STOPPING"
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.listener) await new Promise<void>((resolve) => this.listener!.close(() => resolve()))
    this.listener = null
    this.queue.close()
    this.state = "OFFLINE"
  }
}

export async function sendSimulatorMessage(host: string, port: number, payload: string, protocol: "ASTM" | "HL7_MLLP"): Promise<void> {
  const socket = createConnection({ host, port })
  const framed = protocol === "HL7_MLLP" ? frameHl7Mllp(payload) : payload
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject)
    socket.once("connect", () => socket.end(framed, resolve))
  })
}

export async function uploadPending(
  queue: EdgeDurableQueue,
  endpoint: string,
  bridgeKey: string,
  deviceId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ uploaded: number; failed: number }> {
  let uploaded = 0
  let failed = 0
  for (const item of queue.pending()) {
    queue.markUploading(item.id)
    try {
      const normalized = /^(ASTM|HL7|HL7_MLLP)$/i.test(item.protocol)
        ? (/^ASTM$/i.test(item.protocol) ? parseAstmResults(item.rawPayload, item.id) : parseHl7Results(item.rawPayload, item.id))
        : []
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lab-bridge-key": bridgeKey },
        body: JSON.stringify({
          rawPayload: item.rawPayload,
          protocol: item.protocol,
          deviceId,
          observations: normalized.map((result) => ({
            analyzerCode: result.analyzerCode,
            value: result.value,
            unit: result.unit,
            flags: result.flags,
            instrumentFlags: result.instrumentFlags,
          })),
          accessionNumber: normalized[0]?.accessionNumber,
        }),
      })
      const body = await response.json().catch(() => ({})) as { messageId?: string; error?: string }
      if (!response.ok) {
        queue.markFailed(item.id, body.error ?? `HTTP_${response.status}`, response.status >= 400 && response.status < 500)
        failed += 1
        continue
      }
      queue.markUploaded(item.id, body.messageId)
      uploaded += 1
    } catch (error) {
      queue.markFailed(item.id, error instanceof Error ? error.message : "upload_failed")
      failed += 1
    }
  }
  return { uploaded, failed }
}

export function createEdgeRuntime(path = process.env.SYNAPSE_EDGE_DB ?? ":memory:") {
  return {
    version: LAB_EDGE_VERSION,
    queue: new EdgeDurableQueue(path),
  }
}
