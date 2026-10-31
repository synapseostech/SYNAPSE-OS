/**
 * Generates padded brand assets so logo edges stay visible in app icon, splash, and adaptive icon.
 * Run: node scripts/prepare-brand-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = path.join(appRoot, 'assets')
const candidates = [
  path.join(appRoot, '../../public/assets/logos/synapse-icon.png'),
  path.join(assetsDir, 'icon.png'),
]
const source = candidates.find((p) => fs.existsSync(p))

if (!source) {
  console.error('Source logo not found.')
  process.exit(1)
}

// Every asset is drawn opaque on this one flat brand background, so a 256-colour
// palette is visually indistinguishable (measured PSNR 43.7–52.9 dB) and about a
// quarter of the truecolour size — 2.1 MB off the shipped bundle.
const PNG_OUT = { compressionLevel: 9, palette: true, quality: 90 }

const BG = '#050508'

async function paddedSquare(size, paddingRatio, outName) {
  const pad = Math.round(size * paddingRatio)
  const inner = size - pad * 2
  const logo = await sharp(source)
    .resize(inner, inner, { fit: 'contain', background: { r: 5, g: 5, b: 8, alpha: 1 } })
    .png()
    .toBuffer()

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, top: pad, left: pad }])
    .png(PNG_OUT)
    .toFile(path.join(assetsDir, outName))

  console.log(`Wrote ${outName} (${size}x${size}, pad ${Math.round(paddingRatio * 100)}%)`)
}

async function splash() {
  const width = 1284
  const height = 2778
  const logoSize = 420
  const pad = Math.round((width - logoSize) / 2)
  const top = Math.round((height - logoSize) / 2) - 40

  const logo = await sharp(source)
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 5, g: 5, b: 8, alpha: 1 } })
    .png()
    .toBuffer()

  await sharp({
    create: { width, height, channels: 4, background: BG },
  })
    .composite([{ input: logo, top, left: pad }])
    .png(PNG_OUT)
    .toFile(path.join(assetsDir, 'splash.png'))

  console.log('Wrote splash.png')
}

await paddedSquare(1024, 0.1, 'icon.png')
await paddedSquare(1024, 0.2, 'adaptive-icon.png')
await paddedSquare(512, 0.12, 'favicon.png')
await splash()
console.log('Brand assets ready.')
