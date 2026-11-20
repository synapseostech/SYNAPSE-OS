/**
 * Receipt printer settings saved on this phone.
 *
 * The printer belongs to the counter, not to the pharmacy account: two phones
 * in one shop can point at different printers. So it is stored per device
 * (AsyncStorage, see `printer-store.ts`), and this file only validates and
 * (de)serialises it.
 *
 * No imports: this file must load under both Metro and `node --test`.
 */

export type PrinterKind = "system" | "network" | "bluetooth"
export type PrinterPaperWidth = "58" | "80"

export interface PrinterConfig {
  /** `system` is the OS print dialog (expo-print); the other two send ESC/POS. */
  kind: PrinterKind
  paperWidth: PrinterPaperWidth
  /** Wi-Fi/LAN printer address. */
  host: string
  port: number
  /** Bluetooth MAC address and the name shown when it was picked. */
  bluetoothAddress: string
  bluetoothName: string
  /** Print the receipt straight after a sale on this phone. */
  autoPrint: boolean
  /** Send the cutter command (printers without a cutter ignore it). */
  cut: boolean
}

export const DEFAULT_RAW_PORT = 9100

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  kind: "system",
  paperWidth: "80",
  host: "",
  port: DEFAULT_RAW_PORT,
  bluetoothAddress: "",
  bluetoothName: "",
  autoPrint: false,
  cut: true,
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i

export type AddressResult = { ok: true; host: string; port: number } | { ok: false; error: string }

/**
 * Read what the cashier typed for a Wi-Fi printer: "192.168.1.50",
 * "192.168.1.50:9100" or a local hostname. The port defaults to 9100, the raw
 * printing port every networked ESC/POS printer listens on.
 */
export function parsePrinterAddress(input: string, portInput?: string | number | null): AddressResult {
  let raw = String(input ?? "").trim()
  if (!raw) return { ok: false, error: "Enter the printer's IP address." }
  raw = raw.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")
  let port: number | null = null
  const colon = raw.lastIndexOf(":")
  if (colon > 0 && raw.indexOf(":") === colon) {
    port = Number(raw.slice(colon + 1))
    raw = raw.slice(0, colon)
    if (!Number.isInteger(port)) return { ok: false, error: "The port must be a number, usually 9100." }
  }
  if (portInput !== undefined && portInput !== null && String(portInput).trim() !== "") {
    port = Number(String(portInput).trim())
  }
  const resolvedPort = port ?? DEFAULT_RAW_PORT
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    return { ok: false, error: "The port must be between 1 and 65535 (usually 9100)." }
  }
  const looksNumeric = /^[\d.]+$/.test(raw)
  if (looksNumeric ? !IPV4.test(raw) : !HOSTNAME.test(raw)) {
    return { ok: false, error: "That is not a valid IP address, e.g. 192.168.1.50." }
  }
  return { ok: true, host: raw.toLowerCase(), port: resolvedPort }
}

export function isBluetoothAddress(value: string): boolean {
  return MAC.test(String(value ?? "").trim())
}

/** Whether the saved settings can actually reach a printer. */
export function isPrinterReady(config: PrinterConfig): boolean {
  if (config.kind === "system") return true
  if (config.kind === "network") return parsePrinterAddress(config.host, config.port).ok
  return isBluetoothAddress(config.bluetoothAddress)
}

/** Short label for the setup screen and the receipt screen's print button. */
export function describePrinter(config: PrinterConfig): string {
  if (config.kind === "network") return `Wi-Fi ${config.host}:${config.port}`
  if (config.kind === "bluetooth") return `Bluetooth ${config.bluetoothName || config.bluetoothAddress}`
  return "System print dialog"
}

/** Read stored settings; anything missing or malformed falls back to the defaults. */
export function parsePrinterConfig(raw: string | null | undefined): PrinterConfig {
  if (!raw) return { ...DEFAULT_PRINTER_CONFIG }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_PRINTER_CONFIG }
  }
  if (!value || typeof value !== "object") return { ...DEFAULT_PRINTER_CONFIG }
  const v = value as Record<string, unknown>
  const kind: PrinterKind = v.kind === "network" || v.kind === "bluetooth" ? v.kind : "system"
  const port = Number(v.port)
  return {
    kind,
    paperWidth: v.paperWidth === "58" ? "58" : "80",
    host: typeof v.host === "string" ? v.host.trim() : "",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_RAW_PORT,
    bluetoothAddress: typeof v.bluetoothAddress === "string" ? v.bluetoothAddress.trim() : "",
    bluetoothName: typeof v.bluetoothName === "string" ? v.bluetoothName : "",
    autoPrint: v.autoPrint === true,
    cut: v.cut !== false,
  }
}

export function serialisePrinterConfig(config: PrinterConfig): string {
  return JSON.stringify(config)
}

/**
 * Whether the POS should open the receipt and print it after a sale: the
 * pharmacy may require it, the pharmacy may turn auto-print on for every
 * till, or this phone may have auto-print on for its own printer.
 */
export function shouldOpenReceiptAfterSale(input: {
  mandatoryReceiptPrint: boolean
  pharmacyAutoPrint: boolean
  deviceAutoPrint: boolean
}): boolean {
  return input.mandatoryReceiptPrint || input.pharmacyAutoPrint || input.deviceAutoPrint
}
