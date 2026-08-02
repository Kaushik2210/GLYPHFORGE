import { describe, expect, it } from 'vitest'
import { GlyphField } from '../../field/glyph-field.js'
import { packRgba8 } from '../../color/oklab.js'
import { renderGlyphFieldCpu, type GlyphBitmapProvider } from '../cpu-renderer.js'

/** Deterministic 2x2 test atlas: charIndex 0 = blank, 1 = fully covered. */
function testAtlas(): GlyphBitmapProvider {
  return {
    cellW: 2,
    cellH: 2,
    getBitmap: (charIndex: number) => new Float32Array(4).fill(charIndex === 1 ? 1 : 0),
  }
}

describe('renderGlyphFieldCpu', () => {
  it('produces an image sized cols*cellW x rows*cellH', () => {
    const field = new GlyphField(3, 2)
    const image = renderGlyphFieldCpu(field, testAtlas())
    expect(image.width).toBe(6)
    expect(image.height).toBe(4)
    expect(image.pixels.length).toBe(6 * 4 * 4)
  })

  it('renders blank glyph as pure background color', () => {
    const field = new GlyphField(1, 1)
    field.set(0, 0, { ch: 0, fg: packRgba8(255, 0, 0), bg: packRgba8(0, 255, 0) })
    const image = renderGlyphFieldCpu(field, testAtlas())
    expect([image.pixels[0], image.pixels[1], image.pixels[2]]).toEqual([0, 255, 0])
  })

  it('renders fully-covered glyph as pure foreground color', () => {
    const field = new GlyphField(1, 1)
    field.set(0, 0, { ch: 1, fg: packRgba8(255, 0, 0), bg: packRgba8(0, 255, 0) })
    const image = renderGlyphFieldCpu(field, testAtlas())
    expect([image.pixels[0], image.pixels[1], image.pixels[2]]).toEqual([255, 0, 0])
  })

  it('is deterministic: same input renders bit-identical output twice', () => {
    const field = new GlyphField(4, 4)
    field.set(2, 2, { ch: 1, fg: packRgba8(10, 20, 30), bg: packRgba8(40, 50, 60) })
    const a = renderGlyphFieldCpu(field, testAtlas())
    const b = renderGlyphFieldCpu(field, testAtlas())
    expect(a.pixels).toEqual(b.pixels)
  })
})
