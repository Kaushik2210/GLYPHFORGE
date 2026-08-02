import { oklabDistance, type Oklab } from './oklab.js'

/**
 * Dual-color cell solve — PLAN §4.4. 2-means over a cell's pixels in Oklab yields two
 * cluster centers and a binary assignment mask; matching that mask (a pure shape, see
 * `dualCellMask`) against glyph bitmaps lets a single cell represent a hard color
 * boundary at an arbitrary angle instead of one averaged color. Roughly doubles
 * effective resolution — this is how chafa/viu-quality terminal image viewers work.
 */
export interface DualCellResult {
  /** Darker cluster center. */
  c0: Oklab
  /** Brighter cluster center. */
  c1: Oklab
  /** 1 where a pixel belongs to c1, 0 for c0. */
  mask: Uint8Array
  /** Oklab distance between c0 and c1 — near 0 means the cell is effectively flat. */
  separation: number
}

/** Deterministic (invariant #4: no Math.random) — fixed iteration count, not convergence-based. */
const ITERATIONS = 6

export function solveDualCell(pixels: readonly Oklab[]): DualCellResult {
  const n = pixels.length
  if (n === 0) throw new Error('solveDualCell requires at least one pixel')

  // Deterministic init: the darkest and brightest pixels by L, not random seeds.
  let darkIdx = 0
  let brightIdx = 0
  for (let i = 1; i < n; i++) {
    if (pixels[i]!.L < pixels[darkIdx]!.L) darkIdx = i
    if (pixels[i]!.L > pixels[brightIdx]!.L) brightIdx = i
  }
  let c0: Oklab = { ...pixels[darkIdx]! }
  let c1: Oklab = { ...pixels[brightIdx]! }

  const mask = new Uint8Array(n)
  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) {
      const p = pixels[i]!
      mask[i] = oklabDistance(p, c1) < oklabDistance(p, c0) ? 1 : 0
    }

    let sumL0 = 0
    let sumA0 = 0
    let sumB0 = 0
    let n0 = 0
    let sumL1 = 0
    let sumA1 = 0
    let sumB1 = 0
    let n1 = 0
    for (let i = 0; i < n; i++) {
      const p = pixels[i]!
      if (mask[i] === 1) {
        sumL1 += p.L
        sumA1 += p.a
        sumB1 += p.b
        n1++
      } else {
        sumL0 += p.L
        sumA0 += p.a
        sumB0 += p.b
        n0++
      }
    }
    if (n0 > 0) c0 = { L: sumL0 / n0, a: sumA0 / n0, b: sumB0 / n0 }
    if (n1 > 0) c1 = { L: sumL1 / n1, a: sumA1 / n1, b: sumB1 / n1 }
  }

  if (c0.L > c1.L) {
    const swap = c0
    c0 = c1
    c1 = swap
    for (let i = 0; i < n; i++) mask[i] = mask[i] === 1 ? 0 : 1
  }

  return { c0, c1, mask, separation: oklabDistance(c0, c1) }
}

/** The mask as a Float32Array of 0/1 — directly usable as a matcher tile (pure shape match). */
export function dualCellMaskAsTile(mask: Uint8Array): Float32Array {
  const tile = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) tile[i] = mask[i] ?? 0
  return tile
}
