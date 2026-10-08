import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderInlineBold, splitInlineBold } from './inline-bold'

describe('splitInlineBold (CodeQL js/xss-through-dom #11)', () => {
  it('keeps the existing **bold** formatting', () => {
    expect(splitInlineBold('Hello **world** again')).toEqual([
      { text: 'Hello ', bold: false },
      { text: 'world', bold: true },
      { text: ' again', bold: false },
    ])
  })

  it('shows an unmatched marker literally', () => {
    expect(splitInlineBold('a **b')).toEqual([
      { text: 'a ', bold: false },
      { text: '**b', bold: false },
    ])
  })

  it.each([
    '<img src=x onerror=alert(1)>',
    '**<script>alert(1)</script>**',
    '</strong><iframe src="javascript:alert(1)">',
  ])('renders %s as inert text', (payload) => {
    const html = renderToStaticMarkup(renderInlineBold(payload) as React.ReactElement)
    expect(html).not.toMatch(/<(img|script|iframe)/i)
    expect(html).toContain('&lt;')
  })

  it('handles adversarial marker floods in linear time', () => {
    const start = Date.now()
    splitInlineBold('*'.repeat(200_000) + 'x')
    expect(Date.now() - start).toBeLessThan(200)
  })
})
