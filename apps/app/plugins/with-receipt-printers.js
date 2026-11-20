/**
 * Expo config plugin for direct receipt printing (Wi-Fi/LAN ESC/POS on TCP 9100
 * and Bluetooth Classic SPP).
 *
 * react-native-tcp-socket needs only INTERNET, which the app already has.
 * react-native-bluetooth-classic merges its own permissions into the manifest,
 * but declares ACCESS_FINE_LOCATION for every Android version. Location is only
 * needed to scan for Bluetooth devices up to Android 11; from Android 12 the
 * scan uses BLUETOOTH_SCAN with `neverForLocation`. This plugin pins those
 * declarations so the merged manifest asks for the least the printer needs,
 * whichever order the library manifests merge in.
 *
 * iOS: Bluetooth Classic printers are not MFi accessories, so only the Wi-Fi
 * path works there; the local-network description covers that prompt.
 */
const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins')

const ANDROID_PERMISSIONS = [
  { name: 'android.permission.BLUETOOTH', attrs: { 'android:maxSdkVersion': '30' } },
  { name: 'android.permission.BLUETOOTH_ADMIN', attrs: { 'android:maxSdkVersion': '30' } },
  { name: 'android.permission.ACCESS_FINE_LOCATION', attrs: { 'android:maxSdkVersion': '30' } },
  { name: 'android.permission.BLUETOOTH_CONNECT', attrs: {} },
  { name: 'android.permission.BLUETOOTH_SCAN', attrs: { 'android:usesPermissionFlags': 'neverForLocation' } },
]

function withPrinterAndroidPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest
    manifest.$ = manifest.$ || {}
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools'
    const list = (manifest['uses-permission'] = manifest['uses-permission'] || [])
    for (const { name, attrs } of ANDROID_PERMISSIONS) {
      const existing = list.filter((p) => p.$ && p.$['android:name'] === name)
      for (const p of existing) list.splice(list.indexOf(p), 1)
      const replaced = Object.keys(attrs)
      list.push({
        $: {
          'android:name': name,
          ...attrs,
          // Win over the library's declaration of the same permission.
          ...(replaced.length ? { 'tools:replace': replaced.join(',') } : {}),
        },
      })
    }
    return cfg
  })
}

function withPrinterInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.NSLocalNetworkUsageDescription =
      cfg.modResults.NSLocalNetworkUsageDescription ||
      'Synapse connects to receipt printers on your local network.'
    cfg.modResults.NSBluetoothAlwaysUsageDescription =
      cfg.modResults.NSBluetoothAlwaysUsageDescription ||
      'Synapse connects to Bluetooth receipt printers.'
    return cfg
  })
}

module.exports = function withReceiptPrinters(config) {
  return withPrinterInfoPlist(withPrinterAndroidPermissions(config))
}
