import { describe, expect, it } from 'vitest'
import { matchGlyph } from '../match.js'
import { WEIGHTS_TECHNICAL, type GlyphCandidate } from '../cost.js'

describe('matchGlyph', () => {
  it('selects the candidate with the lowest cost, not the first one', () => {
    const tile = new Float32Array([1, 1, 0, 0])
    const candidates: GlyphCandidate[] = [
      { index: 0, bitmap: new Float32Array([0, 0, 1, 1]), coverage: 0.5 }, // mismatched shape
      { index: 1, bitmap: new Float32Array([1, 1, 0, 0]), coverage: 0.5 }, // exact match
      { index: 2, bitmap: new Float32Array([0.5, 0.5, 0.5, 0.5]), coverage: 0.5 }, // flat
    ]
    const result = matchGlyph(tile, candidates, WEIGHTS_TECHNICAL)
    expect(result.index).toBe(1)
  })

  it('throws on an empty candidate list', () => {
    expect(() => matchGlyph(new Float32Array([0, 1]), [], WEIGHTS_TECHNICAL)).toThrow()
  })

  it('is deterministic across repeated calls', () => {
    const tile = new Float32Array([0.2, 0.8, 0.3, 0.9])
    const candidates: GlyphCandidate[] = [
      { index: 0, bitmap: new Float32Array([0, 1, 0, 1]), coverage: 0.5 },
      { index: 1, bitmap: new Float32Array([1, 0, 1, 0]), coverage: 0.5 },
    ]
    const a = matchGlyph(tile, candidates, WEIGHTS_TECHNICAL)
    const b = matchGlyph(tile, candidates, WEIGHTS_TECHNICAL)
    expect(a).toEqual(b)
  })
})
