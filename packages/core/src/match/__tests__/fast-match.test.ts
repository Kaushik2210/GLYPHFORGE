import { describe, expect, it } from 'vitest'
import { prepareGlyphs, WEIGHTS_TECHNICAL, type GlyphCandidate } from '../cost.js'
import { matchGlyph, matchGlyphFast } from '../match.js'

describe('matchGlyphFast', () => {
  it('agrees with the naive matchGlyph on the same inputs', () => {
    const candidates: GlyphCandidate[] = [
      { index: 0, bitmap: new Float32Array([0, 0, 1, 1]), coverage: 0.5 },
      { index: 1, bitmap: new Float32Array([1, 1, 0, 0]), coverage: 0.5 },
      { index: 2, bitmap: new Float32Array([0.2, 0.8, 0.3, 0.9]), coverage: 0.55 },
      { index: 3, bitmap: new Float32Array([0.5, 0.5, 0.5, 0.5]), coverage: 0.5 },
    ]
    const prepared = prepareGlyphs(candidates)
    const tiles = [
      new Float32Array([1, 1, 0, 0]),
      new Float32Array([0.1, 0.9, 0.2, 0.8]),
      new Float32Array([0.5, 0.5, 0.5, 0.5]),
    ]
    for (const tile of tiles) {
      const naive = matchGlyph(tile, candidates, WEIGHTS_TECHNICAL)
      const fast = matchGlyphFast(tile, prepared, WEIGHTS_TECHNICAL)
      expect(fast.index).toBe(naive.index)
      expect(fast.cost).toBeCloseTo(naive.cost, 4)
    }
  })

  it('throws on an empty prepared list', () => {
    expect(() => matchGlyphFast(new Float32Array([0, 1]), [], WEIGHTS_TECHNICAL)).toThrow()
  })

  it('is deterministic', () => {
    const candidates: GlyphCandidate[] = [
      { index: 0, bitmap: new Float32Array([0, 1, 0, 1]), coverage: 0.5 },
      { index: 1, bitmap: new Float32Array([1, 0, 1, 0]), coverage: 0.5 },
    ]
    const prepared = prepareGlyphs(candidates)
    const tile = new Float32Array([0.2, 0.8, 0.3, 0.9])
    expect(matchGlyphFast(tile, prepared, WEIGHTS_TECHNICAL)).toEqual(matchGlyphFast(tile, prepared, WEIGHTS_TECHNICAL))
  })
})
