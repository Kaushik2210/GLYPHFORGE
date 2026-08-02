import { describe, expect, it } from 'vitest'
import { GlyphField } from '../glyph-field.js'
import { encodeDelta, decodeDelta } from '../delta.js'

describe('field delta (RLE) — invariant #9', () => {
  it('round-trips an empty diff (identical frames)', () => {
    const prev = new GlyphField(10, 10)
    prev.fill({ ch: 1, fg: 0xff, bg: 0x00, flags: 0 })
    const curr = prev.clone()

    const delta = encodeDelta(prev, curr)
    expect(delta.spans).toHaveLength(0)

    const decoded = decodeDelta(prev, delta)
    expect(decoded.equals(curr)).toBe(true)
  })

  it('round-trips a sparse change as a small number of spans', () => {
    const prev = new GlyphField(20, 20)
    prev.fill({ ch: 1, fg: 0, bg: 0, flags: 0 })
    const curr = prev.clone()
    curr.set(5, 5, { ch: 99 })
    curr.set(6, 5, { ch: 99 })
    curr.set(7, 5, { ch: 99 })
    curr.set(15, 15, { ch: 42 })

    const delta = encodeDelta(prev, curr)
    // Two contiguous runs of changed cells in row-major order.
    expect(delta.spans.length).toBe(2)
    expect(delta.spans[0]?.length).toBe(3)
    expect(delta.spans[1]?.length).toBe(1)

    const decoded = decodeDelta(prev, delta)
    expect(decoded.equals(curr)).toBe(true)
  })

  it('cost is proportional to changed cells, not total cells', () => {
    const cols = 200
    const rows = 80
    const prev = new GlyphField(cols, rows)
    const curr = prev.clone()
    curr.set(0, 0, { ch: 1 })

    const delta = encodeDelta(prev, curr)
    const encodedCells = delta.spans.reduce((sum, s) => sum + s.length, 0)
    expect(encodedCells).toBe(1)
    expect(encodedCells).toBeLessThan(cols * rows)
  })

  it('throws on dimension mismatch', () => {
    const a = new GlyphField(4, 4)
    const b = new GlyphField(5, 5)
    expect(() => encodeDelta(a, b)).toThrow()
  })
})
