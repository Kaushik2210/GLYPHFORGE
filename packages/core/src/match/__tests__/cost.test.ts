import { describe, expect, it } from 'vitest'
import { structDistance, toneDistance, cost, WEIGHTS_TECHNICAL, WEIGHTS_CLASSIC, type GlyphCandidate } from '../cost.js'

function diagonalStripe(): Float32Array {
  // A crude 4x4 '/' pattern.
  return new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0])
}

function verticalStripe(): Float32Array {
  return new Float32Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0])
}

describe('structDistance', () => {
  it('is zero for identical patterns', () => {
    const a = diagonalStripe()
    expect(structDistance(a, a)).toBeCloseTo(0, 5)
  })

  it('is invariant to uniform brightness/contrast shifts (mean-subtraction decouples shape from brightness)', () => {
    const a = diagonalStripe()
    const brighter = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) brighter[i] = 0.2 + 0.5 * (a[i] ?? 0)
    expect(structDistance(a, brighter)).toBeCloseTo(0, 5)
  })

  it('is large for orthogonal shapes', () => {
    const diag = diagonalStripe()
    const vert = verticalStripe()
    const same = structDistance(diag, diag)
    const different = structDistance(diag, vert)
    expect(different).toBeGreaterThan(same)
  })
})

describe('toneDistance', () => {
  it('is zero when tile mean equals glyph coverage', () => {
    const tile = new Float32Array([0.5, 0.5, 0.5, 0.5])
    expect(toneDistance(tile, 0.5)).toBeCloseTo(0, 6)
  })

  it('grows with the gap between tile brightness and glyph coverage', () => {
    const tile = new Float32Array([0.9, 0.9, 0.9, 0.9])
    expect(toneDistance(tile, 0.1)).toBeCloseTo(0.8, 6)
  })
})

describe('cost', () => {
  it('a matching-shape candidate scores lower than a mismatched one under Technical weights', () => {
    const tile = diagonalStripe()
    const matching: GlyphCandidate = { index: 0, bitmap: diagonalStripe(), coverage: 0.25 }
    const mismatched: GlyphCandidate = { index: 1, bitmap: verticalStripe(), coverage: 0.25 }
    expect(cost(tile, matching, WEIGHTS_TECHNICAL)).toBeLessThan(cost(tile, mismatched, WEIGHTS_TECHNICAL))
  })

  it('Classic weights (tone-only) ignore structure entirely', () => {
    const tile = diagonalStripe()
    const sameToneDifferentShape: GlyphCandidate = { index: 0, bitmap: verticalStripe(), coverage: 0.25 }
    // Both diagonalStripe and verticalStripe have coverage 4/16 = 0.25, so under Classic
    // weights (wStruct=0) their cost should be identical regardless of shape.
    const identityCost = cost(tile, { index: 1, bitmap: diagonalStripe(), coverage: 0.25 }, WEIGHTS_CLASSIC)
    expect(cost(tile, sameToneDifferentShape, WEIGHTS_CLASSIC)).toBeCloseTo(identityCost, 6)
  })
})
