/**
 * Sends ESC/POS bytes to a thermal printer over Wi-Fi/LAN (raw TCP, port 9100)
 * or Bluetooth Classic (SPP).
 *
 * Both libraries are native modules that only exist in an APK built after they
 * were added. This JavaScript also reaches older APKs through OTA updates, so
 * the modules are required lazily inside try/catch: on a binary without them
 * the transport reports `unavailable` and the receipt screen falls back to the
 * system print dialog (expo-print) instead of crashing at import time.
 */
import { PermissionsAndroid, Platform } from 'react-native'
import { bytesToBase64 } from './escpos'
import type { PrinterConfig } from './printer-config'
import { parsePrinterAddress } from './printer-config'

export class PrinterError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'permission' | 'bluetooth_off' | 'connect' | 'write' | 'config',
  ) {
    super(message)
    this.name = 'PrinterError'
  }
}

type TcpModule = typeof import('react-native-tcp-socket').default
type BluetoothModule = typeof import('react-native-bluetooth-classic').default

let tcpModule: TcpModule | null | undefined
let bluetoothModule: BluetoothModule | null | undefined

function loadTcp(): TcpModule | null {
  if (tcpModule !== undefined) return tcpModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-tcp-socket')
    tcpModule = (mod?.default ?? mod) as TcpModule
    if (typeof tcpModule?.createConnection !== 'function') tcpModule = null
  } catch {
    tcpModule = null
  }
  return tcpModule
}

function loadBluetooth(): BluetoothModule | null {
  if (bluetoothModule !== undefined) return bluetoothModule
  if (Platform.OS !== 'android') {
    // iOS only exposes MFi accessories to Bluetooth Classic; the cheap thermal
    // printers are not MFi, so Bluetooth printing is Android-only.
    bluetoothModule = null
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-bluetooth-classic')
    bluetoothModule = (mod?.default ?? mod) as BluetoothModule
    if (typeof bluetoothModule?.getBondedDevices !== 'function') bluetoothModule = null
  } catch {
    bluetoothModule = null
  }
  return bluetoothModule
}

/** Which direct-print transports this installed APK actually has. */
export function printerTransportsAvailable(): { network: boolean; bluetooth: boolean } {
  return { network: loadTcp() !== null, bluetooth: loadBluetooth() !== null }
}

const NEEDS_NEW_APK =
  'This version of the app cannot print directly. Install the latest Synapse APK, or use the system print dialog.'

// ---------------------------------------------------------------------------
// Wi-Fi / LAN
// ---------------------------------------------------------------------------

/**
 * Open a raw TCP connection, write the job and close. The printer prints as
 * bytes arrive; the job is done once the socket has flushed and closed.
 */
export function sendToNetworkPrinter(
  host: string,
  port: number,
  bytes: Uint8Array,
  timeoutMs = 8000,
): Promise<void> {
  const Tcp = loadTcp()
  if (!Tcp) return Promise.reject(new PrinterError(NEEDS_NEW_APK, 'unavailable'))
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let connected = false
    const finish = (err?: PrinterError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* already closed */
      }
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(
        new PrinterError(
          connected
            ? 'The printer stopped responding while printing.'
            : `No printer answered at ${host}:${port}. Check it is on and on the same Wi-Fi as this phone.`,
          connected ? 'write' : 'connect',
        ),
      )
    }, timeoutMs)
    const socket = Tcp.createConnection({ host, port, connectTimeout: timeoutMs }, () => {
      connected = true
      socket.write(bytes, undefined, (err?: Error) => {
        if (err) {
          finish(new PrinterError(`Printing failed: ${err.message}`, 'write'))
          return
        }
        // Half-close; the printer closes its side once it has the data.
        socket.end()
      })
    })
    socket.on('close', () => {
      if (connected) finish()
    })
    socket.on('error', (err: Error) => {
      finish(
        new PrinterError(
          connected
            ? `Printing failed: ${err.message}`
            : `Could not reach the printer at ${host}:${port} (${err.message}).`,
          connected ? 'write' : 'connect',
        ),
      )
    })
  })
}

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

export interface BluetoothPrinterCandidate {
  name: string
  address: string
  bonded: boolean
}

/** Runtime permissions for Bluetooth Classic: CONNECT/SCAN on Android 12+, location before that. */
export async function ensureBluetoothPermissions(scan: boolean): Promise<void> {
  if (Platform.OS !== 'android') return
  const api = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version)
  const wanted =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ...(scan ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] : []),
        ]
      : scan
        ? [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
        : []
  if (wanted.length === 0) return
  const result = await PermissionsAndroid.requestMultiple(wanted)
  const denied = wanted.filter((p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED)
  if (denied.length > 0) {
    throw new PrinterError(
      scan
        ? 'Allow "Nearby devices" for Synapse in Android settings to find Bluetooth printers.'
        : 'Allow "Nearby devices" for Synapse in Android settings to print over Bluetooth.',
      'permission',
    )
  }
}

async function bluetoothReady(scan: boolean): Promise<BluetoothModule> {
  const Bt = loadBluetooth()
  if (!Bt) {
    throw new PrinterError(
      Platform.OS === 'android' ? NEEDS_NEW_APK : 'Bluetooth receipt printers are supported on Android only.',
      'unavailable',
    )
  }
  await ensureBluetoothPermissions(scan)
  if (!(await Bt.isBluetoothAvailable())) {
    throw new PrinterError('This phone has no Bluetooth.', 'unavailable')
  }
  if (!(await Bt.isBluetoothEnabled())) {
    const enabled = await Bt.requestBluetoothEnabled().catch(() => false)
    if (!enabled) throw new PrinterError('Turn Bluetooth on to print the receipt.', 'bluetooth_off')
  }
  return Bt
}

/** Printers already paired in Android settings (the usual way a thermal printer is set up). */
export async function listPairedPrinters(): Promise<BluetoothPrinterCandidate[]> {
  const Bt = await bluetoothReady(false)
  const devices = await Bt.getBondedDevices()
  return devices.map((d) => ({ name: d.name || d.address, address: d.address, bonded: true }))
}

/** Scan for nearby Bluetooth devices (about 12 seconds on most phones). */
export async function discoverPrinters(): Promise<BluetoothPrinterCandidate[]> {
  const Bt = await bluetoothReady(true)
  const devices = await Bt.startDiscovery()
  return devices.map((d) => ({ name: d.name || d.address, address: d.address, bonded: Boolean(d.bonded) }))
}

export async function cancelPrinterDiscovery(): Promise<void> {
  const Bt = loadBluetooth()
  await Bt?.cancelDiscovery().catch(() => false)
}

export async function pairPrinter(address: string): Promise<BluetoothPrinterCandidate> {
  const Bt = await bluetoothReady(true)
  const d = await Bt.pairDevice(address)
  return { name: d.name || d.address, address: d.address, bonded: true }
}

/** Cheap SPP printers have small buffers; write in slices so long receipts do not drop bytes. */
const BLUETOOTH_CHUNK = 512
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function sendToBluetoothPrinter(address: string, bytes: Uint8Array): Promise<void> {
  const Bt = await bluetoothReady(false)
  let device
  try {
    const already = await Bt.isDeviceConnected(address).catch(() => false)
    device = already
      ? await Bt.getConnectedDevice(address)
      : await Bt.connectToDevice(address, { connectionType: 'binary' })
  } catch (err) {
    throw new PrinterError(
      `Could not connect to the Bluetooth printer. Check it is on and paired${
        err instanceof Error && err.message ? ` (${err.message})` : ''
      }.`,
      'connect',
    )
  }
  try {
    for (let i = 0; i < bytes.length; i += BLUETOOTH_CHUNK) {
      const ok = await device.write(bytesToBase64(bytes.subarray(i, i + BLUETOOTH_CHUNK)), 'base64')
      if (!ok) throw new Error('write refused')
      if (i + BLUETOOTH_CHUNK < bytes.length) await pause(20)
    }
  } catch (err) {
    throw new PrinterError(
      `Printing over Bluetooth failed${err instanceof Error && err.message ? `: ${err.message}` : ''}.`,
      'write',
    )
  } finally {
    // Let the printer drain its buffer before the link drops.
    await pause(300)
    await device.disconnect().catch(() => false)
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Send a prepared ESC/POS job to the printer saved on this phone. */
export async function sendToConfiguredPrinter(config: PrinterConfig, bytes: Uint8Array): Promise<void> {
  if (config.kind === 'network') {
    const address = parsePrinterAddress(config.host, config.port)
    if (!address.ok) throw new PrinterError(address.error, 'config')
    await sendToNetworkPrinter(address.host, address.port, bytes)
    return
  }
  if (config.kind === 'bluetooth') {
    if (!config.bluetoothAddress) throw new PrinterError('Choose a Bluetooth printer in Printer setup.', 'config')
    await sendToBluetoothPrinter(config.bluetoothAddress, bytes)
    return
  }
  throw new PrinterError('No direct printer is set up on this phone.', 'config')
}
