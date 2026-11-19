import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  DEFAULT_PRINTER_CONFIG,
  parsePrinterConfig,
  serialisePrinterConfig,
  type PrinterConfig,
} from './printer-config'

/** Per-device: the printer belongs to this counter, not to the pharmacy account. */
const PRINTER_KEY = 'synapse.printer.v1'

export async function loadPrinterConfig(): Promise<PrinterConfig> {
  const raw = await AsyncStorage.getItem(PRINTER_KEY).catch(() => null)
  return parsePrinterConfig(raw)
}

export async function savePrinterConfig(config: PrinterConfig): Promise<void> {
  await AsyncStorage.setItem(PRINTER_KEY, serialisePrinterConfig(config))
}

/** The saved printer, re-read whenever `reload` is called (e.g. on screen focus). */
export function usePrinterConfig(): {
  config: PrinterConfig
  loaded: boolean
  reload: () => Promise<void>
} {
  const [config, setConfig] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG)
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(async () => {
    setConfig(await loadPrinterConfig())
    setLoaded(true)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { config, loaded, reload }
}
