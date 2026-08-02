import { cost, tileConfidence, type GlyphCandidate, type MatchWeights, type PreparedGlyph } from './cost.js'

const EPSILON = 1e-6

export interface MatchResult {
  index: number
  cost: number
}

/**
 * Brute-force argmin over candidates — PLAN §4.2: with realistic charset sizes (tens to
 * low hundreds of glyphs) this is trivially cheap. Do not replace with a k-d tree/PCA
 * projection unless the bench proves brute force is the bottleneck.
 */
export function matchGlyph(tile: Float32Array, candidates: readonly GlyphCandidate[], weights: MatchWeights): MatchResult {
  if (candidates.length === 0) throw new Error('matchGlyph requires at least one candidate')
  let best: MatchResult = { index: candidates[0]!.index, cost: Infinity }
  for (const candidate of candidates) {
    const c = cost(tile, candidate, weights)
    if (c < best.cost) {
      best = { index: candidate.index, cost: c }
    }
  }
  return best
}

/**
 * Same result as `matchGlyph`, but against glyphs precomputed via `prepareGlyphs` — the
 * per-tile cost drops from two O(n) passes per candidate to one, because each glyph's
 * mean/norm is already baked into `normalized`. Use this for any bulk conversion (an
 * image or video frame); use `matchGlyph` when matching against ad-hoc candidates.
 */
export function matchGlyphFast(tile: Float32Array, prepared: readonly PreparedGlyph[], weights: MatchWeights): MatchResult {
  if (prepared.length === 0) throw new Error('matchGlyphFast requires at least one candidate')
  const n = tile.length

  let meanT = 0
  for (let i = 0; i < n; i++) meanT += tile[i] ?? 0
  meanT /= n

  const centered = new Float32Array(n)
  let normSq = 0
  for (let i = 0; i < n; i++) {
    const v = (tile[i] ?? 0) - meanT
    centered[i] = v
    normSq += v * v
  }
  const tileNorm = Math.sqrt(normSq) + EPSILON
  // Flat tiles (near-zero variance) make normalized cross-correlation numerically
  // unstable — fade the structure term out so tone alone decides. See cost.ts.
  const confidence = tileConfidence(tile)

  let best: MatchResult = { index: prepared[0]!.index, cost: Infinity }
  for (const glyph of prepared) {
    let dot = 0
    for (let i = 0; i < n; i++) {
      dot += (centered[i] ?? 0) * (glyph.normalized[i] ?? 0)
    }
    const structDist = 1 - dot / tileNorm
    const toneDist = Math.abs(meanT - glyph.coverage)
    const c = weights.wStruct * structDist * confidence + weights.wTone * toneDist
    if (c < best.cost) {
      best = { index: glyph.index, cost: c }
    }
  }
  return best
}
