import type { GradientField } from './fields.js'

/**
 * Structure-tensor coherence per cell — PLAN §5.1 step 6-7. Distinguishes "a clean edge
 * with one orientation" from "noisy texture": without this term, textured/noisy regions
 * fill with random directional glyphs and the whole image looks scratchy; with it,
 * directional overrides only fire where a human would actually draw a line.
 */
export interface CellEdge {
  /** Mean gradient magnitude over the cell. */
  magnitude: number
  /** Dominant edge/line direction in radians, range [0, pi) (180 deg periodic). */
  angle: number
  /** 0 (no consistent orientation) to 1 (one clean orientation dominates). */
  coherence: number
}

export function computeCellEdge(grad: GradientField, cellCol: number, cellRow: number, cellW: number, cellH: number): CellEdge {
  let ixx = 0
  let iyy = 0
  let ixy = 0
  let magSum = 0
  let n = 0

  for (let y = 0; y < cellH; y++) {
    const py = cellRow * cellH + y
    if (py >= grad.height) continue
    for (let x = 0; x < cellW; x++) {
      const px = cellCol * cellW + x
      if (px >= grad.width) continue
      const idx = py * grad.width + px
      const gx = grad.gx[idx] ?? 0
      const gy = grad.gy[idx] ?? 0
      ixx += gx * gx
      iyy += gy * gy
      ixy += gx * gy
      magSum += grad.magnitude[idx] ?? 0
      n++
    }
  }
  if (n === 0) return { magnitude: 0, angle: 0, coherence: 0 }

  const trace = ixx + iyy
  const disc = Math.sqrt((ixx - iyy) * (ixx - iyy) + 4 * ixy * ixy)
  const lambda1 = (trace + disc) / 2
  const lambda2 = (trace - disc) / 2
  const coherence = trace > 1e-9 ? (lambda1 - lambda2) / trace : 0

  // Structure-tensor orientation gives the dominant GRADIENT direction; the edge/line
  // itself runs perpendicular to that.
  const gradAngle = 0.5 * Math.atan2(2 * ixy, ixx - iyy)
  const angle = normalizeAngle(gradAngle + Math.PI / 2)

  return { magnitude: magSum / n, angle, coherence }
}

function normalizeAngle(angle: number): number {
  const twoPi = Math.PI
  return ((angle % twoPi) + twoPi) % twoPi
}

export type Direction = '-' | '|' | '/' | '\\'

/** Quantizes a line-direction angle into the 4-way directional charset (PLAN §3.1 `directional`). */
export function classifyDirection(angle: number): Direction {
  const a = normalizeAngle(angle)
  if (a < Math.PI / 8 || a >= (7 * Math.PI) / 8) return '-'
  if (a < (3 * Math.PI) / 8) return '/'
  if (a < (5 * Math.PI) / 8) return '|'
  return '\\'
}
