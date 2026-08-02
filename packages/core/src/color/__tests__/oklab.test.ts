import { describe, expect, it } from 'vitest'
import {
  srgbToLinear,
  linearToSrgb,
  linearToOklab,
  oklabToLinear,
  oklabDistance,
  packRgba8,
  unpackRgba8,
} from '../oklab.js'

describe('sRGB <-> linear (invariant #1)', () => {
  it('round-trips within floating point tolerance', () => {
    for (const v of [0, 0.02, 0.04045, 0.1, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6)
    }
  })

  it('is monotonic increasing', () => {
    let prev = -Infinity
    for (let v = 0; v <= 1; v += 0.05) {
      const linear = srgbToLinear(v)
      expect(linear).toBeGreaterThan(prev)
      prev = linear
    }
  })

  it('black stays black, white stays white', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBeCloseTo(1, 6)
  })
})

describe('Oklab (invariant #2)', () => {
  it('round-trips linear RGB -> Oklab -> linear RGB', () => {
    const samples = [
      { r: 0, g: 0, b: 0 },
      { r: 1, g: 1, b: 1 },
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
      { r: 0.5, g: 0.25, b: 0.75 },
    ]
    for (const rgb of samples) {
      const lab = linearToOklab(rgb)
      const back = oklabToLinear(lab)
      expect(back.r).toBeCloseTo(rgb.r, 4)
      expect(back.g).toBeCloseTo(rgb.g, 4)
      expect(back.b).toBeCloseTo(rgb.b, 4)
    }
  })

  it('achromatic grey has near-zero a/b channels', () => {
    const lab = linearToOklab({ r: 0.5, g: 0.5, b: 0.5 })
    expect(Math.abs(lab.a)).toBeLessThan(1e-6)
    expect(Math.abs(lab.b)).toBeLessThan(1e-6)
  })

  it('distance is zero for identical colors and positive for distinct ones', () => {
    const a = linearToOklab({ r: 0.2, g: 0.4, b: 0.6 })
    const b = linearToOklab({ r: 0.8, g: 0.1, b: 0.1 })
    expect(oklabDistance(a, a)).toBe(0)
    expect(oklabDistance(a, b)).toBeGreaterThan(0)
  })
})

describe('rgba8 packing', () => {
  it('round-trips through the Uint32 layout used by GlyphField.fg/bg', () => {
    const packed = packRgba8(10, 20, 30, 255)
    expect(unpackRgba8(packed)).toEqual({ r: 10, g: 20, b: 30, a: 255 })
  })
})
