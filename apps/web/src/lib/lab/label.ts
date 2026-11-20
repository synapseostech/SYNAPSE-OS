import { code128Svg } from '@synapse/db/barcode-code128'
import { formatAge } from '@synapse/db/lab-ranges'

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export type SpecimenLabelInput = {
  accession: string
  patientName: string | null
  patientMrn: string | null
  sex: string | null
  dob: string | null
  testName: string
  section: string | null
  specimenType: string | null
  container: string | null
  collectedAt: string | null
  urgency: string
}

/** Print CSP for server-rendered HTML: no scripts, no network, inline styles only. */
export const PRINT_HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
}

/**
 * A 50 × 25 mm tube label (the common thermal label size), one per page so a
 * label printer cuts between copies. Code 128 carries the accession, which is
 * what analysers and the ingest route match on.
 */
export function renderSpecimenLabels(input: SpecimenLabelInput, copies = 1): string {
  const n = Math.min(Math.max(Math.trunc(copies) || 1, 1), 6)
  const age = formatAge(input.dob)
  const when = input.collectedAt ? new Date(input.collectedAt).toISOString().replace('T', ' ').slice(5, 16) : ''
  const label = `<section class="label">
<div class="row"><strong class="name">${esc(input.patientName ?? 'Unknown patient')}</strong><span>${esc(input.sex ?? '')}${age ? ` ${esc(age)}` : ''}</span></div>
<div class="row small"><span>${esc(input.patientMrn ?? '')}</span><span>${esc(when)}</span></div>
<div class="bar">${code128Svg(input.accession, { height: 34, moduleWidth: 1, quiet: 6 })}</div>
<div class="row small"><strong>${esc(input.accession)}</strong>${input.urgency !== 'ROUTINE' ? `<strong>${esc(input.urgency)}</strong>` : ''}</div>
<div class="row small"><span>${esc(input.testName)}</span><span>${esc(input.container ?? input.specimenType ?? '')}</span></div>
</section>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Label ${esc(input.accession)}</title><style>
@page{size:50mm 25mm;margin:0}
html,body{margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
.label{width:50mm;height:25mm;box-sizing:border-box;padding:1mm 1.5mm;overflow:hidden;page-break-after:always;break-after:page}
.row{display:flex;justify-content:space-between;gap:2mm;font-size:7pt;line-height:1.15;white-space:nowrap;overflow:hidden}
.small{font-size:6pt}.name{overflow:hidden;text-overflow:ellipsis}
.bar svg{width:100%;height:9mm;display:block}
@media screen{body{background:#eee;padding:8px}.label{background:#fff;margin:0 0 8px;outline:1px dashed #999}}
</style></head><body>${Array.from({ length: n }, () => label).join('')}</body></html>`
}
