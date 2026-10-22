import { createElement, Fragment, type ReactNode } from 'react'

const MAX_RENDERED_CHARS = 20_000

/**
 * Split text on `**bold**` markers without regex backtracking. Returns plain
 * text segments plus a flag for bold. Never produces HTML: callers render the
 * segments as React text nodes, so `<script>` etc. stay inert text.
 */
export function splitInlineBold(text: string): Array<{ text: string; bold: boolean }> {
  const src = String(text ?? '').slice(0, MAX_RENDERED_CHARS)
  const parts: Array<{ text: string; bold: boolean }> = []
  let i = 0
  let bold = false
  while (i <= src.length) {
    const next = src.indexOf('**', i)
    if (next === -1) {
      const tail = src.slice(i)
      // An unmatched opening `**` is shown literally.
      if (tail || bold) parts.push({ text: bold ? `**${tail}` : tail, bold: false })
      break
    }
    const chunk = src.slice(i, next)
    if (chunk) parts.push({ text: chunk, bold })
    bold = !bold
    i = next + 2
  }
  return parts.filter((p) => p.text.length > 0)
}

/** React rendering of `splitInlineBold` — safe replacement for dangerouslySetInnerHTML. */
export function renderInlineBold(text: string): ReactNode {
  return createElement(
    Fragment,
    null,
    ...splitInlineBold(text).map((p, idx) =>
      p.bold ? createElement('strong', { key: idx }, p.text) : createElement(Fragment, { key: idx }, p.text),
    ),
  )
}
