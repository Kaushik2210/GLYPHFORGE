import { describe, expect, it } from 'vitest'
import { GlyphField } from '../../field/glyph-field.js'
import { packRgba8 } from '../../color/oklab.js'
import { fieldToText, fieldToAnsi } from '../export-text.js'

describe('fieldToText', () => {
  it('maps ch indices through the codepoint lookup, row by row', () => {
    const field = new GlyphField(3, 2)
    field.fill({ ch: 0, fg: 0, bg: 0, flags: 0 })
    field.set(1, 0, { ch: 1 })
    field.set(0, 1, { ch: 2 })
    const codepoints = [0x2e, 0x40, 0x23] // '.', '@', '#'
    expect(fieldToText(field, codepoints)).toBe('.@.\n#..')
  })

  it('falls back to a space for an out-of-range ch index', () => {
    const field = new GlyphField(1, 1)
    field.set(0, 0, { ch: 5 })
    expect(fieldToText(field, [0x2e])).toBe(' ')
  })
})

describe('fieldToAnsi', () => {
  it('emits a 24-bit truecolor escape once per color run, then resets at end of line', () => {
    const field = new GlyphField(2, 1)
    field.set(0, 0, { ch: 0, fg: packRgba8(255, 0, 0), bg: packRgba8(0, 0, 0) })
    field.set(1, 0, { ch: 0, fg: packRgba8(255, 0, 0), bg: packRgba8(0, 0, 0) })
    const out = fieldToAnsi(field, [0x2e])
    const escCount = (out.match(/\[38;2;255;0;0m/g) ?? []).length
    expect(escCount).toBe(1) // same color for both cells -> emitted once, not twice
    expect(out.endsWith('[0m')).toBe(true)
    expect(out).toContain('..')
  })

  it('re-emits color codes when fg or bg changes mid-line', () => {
    const field = new GlyphField(2, 1)
    field.set(0, 0, { ch: 0, fg: packRgba8(255, 0, 0), bg: 0 })
    field.set(1, 0, { ch: 0, fg: packRgba8(0, 255, 0), bg: 0 })
    const out = fieldToAnsi(field, [0x2e])
    expect(out).toContain('38;2;255;0;0')
    expect(out).toContain('38;2;0;255;0')
  })
})
