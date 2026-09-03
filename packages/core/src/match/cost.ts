/**
 * The matcher cost function — PLAN.md §4.1 / CLAUDE.md "The matcher cost function".
 * Change this file carefully; it is the difference between "ASCII art" and mush.
 *
 * This first pass implements the two load-bearing terms, D_struct and D_tone.
 * D_edge (orientation histogram), w_temp (hysteresis), and w_prior (charset penalty)
 * are Phase 3/7 work — the weight fields exist now so callers don't need to change
 * shape when those land.
 */
export interface MatchWeights {
  wStruct: number
  wTone: number
  wEdge: number
  wTemp: number
  wPrior: number
}

export const WEIGHTS_PHOTOGRAPHIC: MatchWeights = { wStruct: 0.5, wTone: 1.0, wEdge: 0.3, wTemp: 0, wPrior: 0 }
export const WEIGHTS_TECHNICAL: MatchWeights = { wStruct: 1.0, wTone: 0.4, wEdge: 0.8, wTemp: 0, wPrior: 0 }
export const WEIGHTS_DRAMATIC: MatchWeights = { wStruct: 0.8, wTone: 0.3, wEdge: 1.0, wTemp: 0, wPrior: 0 }
export const WEIGHTS_CLASSIC: MatchWeights = { wStruct: 0, wTone: 1.0, wEdge: 0, wTemp: 0, wPrior: 0 }

const EPSILON = 1e-6

/**
 * Below this per-pixel standard deviation, a tile is "flat": it has no measurable shape,
 * so normalized cross-correlation against it is numerically unstable (dividing by a
 * near-zero norm) and effectively picks a glyph by noise rather than signal. Below the
 * threshold we fade the structure term toward 0 so tone alone decides — the single-cell
 * analogue of the dual-cell "degenerate case" in PLAN §4.4. Without this, large flat
 * regions (skies, walls, a bright circle) render as a near-random texture of glyphs
 * instead of a clean tone gradient.
 *
 * Measured against synthetic gradient tiles: a very gentle photographic gradient
 * (ΔL~0.03 across a cell) already produced confidence 0.37 at the original 0.025
 * threshold — enough structure weight to flip glyph *shape* between adjacent,
 * similarly-toned rows, which reads as banding/noise even though each row's tone choice
 * is individually correct. That measurement predates the caller's denoise blur (App.tsx,
 * gaussianBlur sigma=2.5) — re-measured against denoised tiles (see
 * tmp-separation-probe.test.ts in this package's __tests__): a gentle gradient now lands
 * at confidence ~0.005 and 8x8 ordered-dither noise at 0, both already suppressed by the
 * blur itself, while a real hard edge still saturates to confidence 1. 0.09 kept a steep
 * gradient's legitimate structure (confidence ~0.08, i.e. barely engaged) suppressed for
 * no remaining reason once the blur was doing the actual noise-defeating work — lowered
 * to keep a comfortable margin above the measured post-denoise noise floor (~6x) while
 * letting real texture and softer edges engage the structure term again.
 */
const FLAT_TILE_STD_THRESHOLD = 0.03

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Normalized cross-correlation on mean-subtracted patches, returned as a [0,2] distance
 * (1 - correlation). Mean-subtraction decouples shape from brightness (CLAUDE.md).
 * `tile` and `glyph` must be the same length (cellW*cellH).
 */
export function structDistance(tile: Float32Array, glyph: Float32Array): number {
  const n = tile.length
  let meanT = 0
  let meanG = 0
  for (let i = 0; i < n; i++) {
    meanT += tile[i] ?? 0
    meanG += glyph[i] ?? 0
  }
  meanT /= n
  meanG /= n

  let dot = 0
  let normT = 0
  let normG = 0
  for (let i = 0; i < n; i++) {
    const t = (tile[i] ?? 0) - meanT
    const g = (glyph[i] ?? 0) - meanG
    dot += t * g
    normT += t * t
    normG += g * g
  }
  const correlation = dot / (Math.sqrt(normT * normG) + EPSILON)
  return 1 - correlation
}

/** |mean(tile) - calibratedLuma(glyph)|. `glyphCoverage` is the glyph's own mean coverage. */
export function toneDistance(tile: Float32Array, glyphCoverage: number): number {
  let meanT = 0
  for (let i = 0; i < tile.length; i++) meanT += tile[i] ?? 0
  meanT /= tile.length
  return Math.abs(meanT - glyphCoverage)
}

/**
 * 0 for a perfectly flat tile, ramping to 1 once the tile's per-pixel std deviation
 * clears `FLAT_TILE_STD_THRESHOLD`. Multiply the structure term by this so flat regions
 * fall back to pure tone matching instead of unstable near-zero-variance correlation.
 */
export function tileConfidence(tile: Float32Array): number {
  const n = tile.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += tile[i] ?? 0
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i++) {
    const d = (tile[i] ?? 0) - mean
    variance += d * d
  }
  variance /= n
  const std = Math.sqrt(variance)
  return clamp01(std / FLAT_TILE_STD_THRESHOLD)
}

export interface GlyphCandidate {
  index: number
  bitmap: Float32Array
  coverage: number
}

export function cost(tile: Float32Array, candidate: GlyphCandidate, weights: MatchWeights): number {
  const confidence = tileConfidence(tile)
  return (
    weights.wStruct * structDistance(tile, candidate.bitmap) * confidence + weights.wTone * toneDistance(tile, candidate.coverage)
  )
}

/**
 * A glyph's mean and L2 norm never depend on the tile being matched, so recomputing them
 * for every cell (as the naive `structDistance` call does) is pure waste: for a 110x47
 * grid against a 95-glyph charset that's ~15,840x1 recomputations of each glyph's own
 * statistics. Precompute once per glyph via `prepareGlyphs`; `matchGlyphFast` (match.ts)
 * then does one dot-product loop per candidate instead of two full mean/variance passes.
 */
export interface PreparedGlyph {
  index: number
  coverage: number
  /** Mean-subtracted, L2-normalized bitmap. */
  normalized: Float32Array
}

export function prepareGlyph(candidate: GlyphCandidate): PreparedGlyph {
  const n = candidate.bitmap.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += candidate.bitmap[i] ?? 0
  mean /= n

  const centered = new Float32Array(n)
  let normSq = 0
  for (let i = 0; i < n; i++) {
    const v = (candidate.bitmap[i] ?? 0) - mean
    centered[i] = v
    normSq += v * v
  }
  const norm = Math.sqrt(normSq) + EPSILON
  for (let i = 0; i < n; i++) {
    centered[i] = (centered[i] ?? 0) / norm
  }
  return { index: candidate.index, coverage: candidate.coverage, normalized: centered }
}

export function prepareGlyphs(candidates: readonly GlyphCandidate[]): PreparedGlyph[] {
  return candidates.map(prepareGlyph)
}
