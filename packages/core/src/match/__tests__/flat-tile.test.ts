import { describe, expect, it } from 'vitest'
import { tileConfidence, prepareGlyphs, WEIGHTS_TECHNICAL, type GlyphCandidate } from '../cost.js'
import { matchGlyphFast } from '../match.js'

describe('tileConfidence', () => {
  it('is 0 for a perfectly flat tile', () => {
    expect(tileConfidence(new Float32Array(16).fill(0.5))).toBe(0)
  })

  it('is 1 once the tile has meaningful contrast', () => {
    const tile = new Float32Array(16)
    for (let i = 0; i < 16; i++) tile[i] = i % 2 === 0 ? 0 : 1
    expect(tileConfidence(tile)).toBe(1)
  })
})

describe('flat-tile fallback (structure term fades out on near-zero-variance tiles)', () => {
  it('a flat tile picks the candidate closest in tone, even under structure-heavy weights', () => {
    const candidates: GlyphCandidate[] = [
      // Two very different shapes that both happen to have coverage far from the tile...
      { index: 0, bitmap: new Float32Array([0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0]), coverage: 0.1 },
      { index: 1, bitmap: new Float32Array([1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1]), coverage: 0.1 },
      // ...and one flat-ish, low-contrast glyph whose coverage matches the tile closely.
      { index: 2, bitmap: new Float32Array(16).fill(0.78), coverage: 0.78 },
    ]
    const prepared = prepareGlyphs(candidates)
    const flatTile = new Float32Array(16).fill(0.8) // bright, uniform — a sky, a wall, a flat highlight

    const result = matchGlyphFast(flatTile, prepared, WEIGHTS_TECHNICAL)
    expect(result.index).toBe(2)
  })
})
