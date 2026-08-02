import { describe, expect, it } from 'vitest'
import { GlyphField, FLAG_DUAL_COLOR } from '../glyph-field.js'

describe('GlyphField', () => {
  it('is backed by parallel typed arrays, not an array of cell objects (invariant #6)', () => {
    const field = new GlyphField(4, 3)
    expect(field.ch).toBeInstanceOf(Uint16Array)
    expect(field.fg).toBeInstanceOf(Uint32Array)
    expect(field.bg).toBeInstanceOf(Uint32Array)
    expect(field.flags).toBeInstanceOf(Uint8Array)
    expect(field.length).toBe(12)
  })

  it('rejects non-positive dimensions', () => {
    expect(() => new GlyphField(0, 5)).toThrow()
    expect(() => new GlyphField(5, -1)).toThrow()
  })

  it('round-trips get/set per cell', () => {
    const field = new GlyphField(4, 3)
    field.set(2, 1, { ch: 65, fg: 0x11223344, bg: 0xaabbccdd, flags: FLAG_DUAL_COLOR })
    const cell = field.get(2, 1)
    expect(cell).toEqual({ ch: 65, fg: 0x11223344, bg: 0xaabbccdd, flags: FLAG_DUAL_COLOR })
  })

  it('partial set only overwrites provided fields', () => {
    const field = new GlyphField(2, 2)
    field.set(0, 0, { ch: 1, fg: 2, bg: 3, flags: 4 })
    field.set(0, 0, { ch: 9 })
    expect(field.get(0, 0)).toEqual({ ch: 9, fg: 2, bg: 3, flags: 4 })
  })

  it('clone produces an independent, equal copy', () => {
    const field = new GlyphField(3, 3)
    field.set(1, 1, { ch: 42 })
    const clone = field.clone()
    expect(clone.equals(field)).toBe(true)
    clone.set(1, 1, { ch: 7 })
    expect(clone.equals(field)).toBe(false)
    expect(field.get(1, 1).ch).toBe(42)
  })

  it('resized preserves the overlapping region and blanks new cells', () => {
    const field = new GlyphField(2, 2)
    field.fill({ ch: 5, fg: 1, bg: 2, flags: 0 })
    const grown = field.resized(3, 3)
    expect(grown.get(0, 0).ch).toBe(5)
    expect(grown.get(1, 1).ch).toBe(5)
    expect(grown.get(2, 2).ch).toBe(0)

    const shrunk = field.resized(1, 1)
    expect(shrunk.get(0, 0).ch).toBe(5)
    expect(shrunk.cols).toBe(1)
    expect(shrunk.rows).toBe(1)
  })

  it('index is row-major', () => {
    const field = new GlyphField(4, 3)
    expect(field.index(0, 0)).toBe(0)
    expect(field.index(3, 0)).toBe(3)
    expect(field.index(0, 1)).toBe(4)
  })
})
