import type { GlyphField } from '../field/glyph-field.js'
import { srgbToLinear, linearToSrgb, unpackRgba8 } from '../color/oklab.js'

/**
 * Per-glyph coverage bitmap source. In Phase 1 this is backed by supersampled font
 * rasterization (PLAN §3.1); tests and the fidelity harness can substitute any provider
 * that satisfies this shape, so the renderer never depends on a real font.
 */
export interface GlyphBitmapProvider {
  cellW: number
  cellH: number
  /** Coverage in [0,1], row-major, length cellW*cellH. */
  getBitmap(charIndex: number): Float32Array
}

export interface RenderedImage {
  width: number
  height: number
  /** sRGB8, row-major, RGBA. */
  pixels: Uint8ClampedArray
}

/**
 * The CPU reference renderer — the correctness oracle for the GPU instanced renderer
 * (invariant #5) and the re-render step of the fidelity metric (PLAN §11.1).
 * All compositing happens in linear light (invariant #1); sRGB only at the boundary.
 */
export function renderGlyphFieldCpu(field: GlyphField, atlas: GlyphBitmapProvider): RenderedImage {
  const { cellW, cellH } = atlas
  const width = field.cols * cellW
  const height = field.rows * cellH
  const pixels = new Uint8ClampedArray(width * height * 4)

  for (let cy = 0; cy < field.rows; cy++) {
    for (let cx = 0; cx < field.cols; cx++) {
      const cell = field.get(cx, cy)
      const fg = unpackRgba8(cell.fg)
      const bg = unpackRgba8(cell.bg)
      const fgLin = { r: srgbToLinear(fg.r / 255), g: srgbToLinear(fg.g / 255), b: srgbToLinear(fg.b / 255) }
      const bgLin = { r: srgbToLinear(bg.r / 255), g: srgbToLinear(bg.g / 255), b: srgbToLinear(bg.b / 255) }
      const bitmap = atlas.getBitmap(cell.ch)

      for (let py = 0; py < cellH; py++) {
        for (let px = 0; px < cellW; px++) {
          const coverage = bitmap[py * cellW + px] ?? 0
          const rLin = bgLin.r + (fgLin.r - bgLin.r) * coverage
          const gLin = bgLin.g + (fgLin.g - bgLin.g) * coverage
          const bLin = bgLin.b + (fgLin.b - bgLin.b) * coverage

          const outX = cx * cellW + px
          const outY = cy * cellH + py
          const outIdx = (outY * width + outX) * 4
          pixels[outIdx] = Math.round(linearToSrgb(rLin) * 255)
          pixels[outIdx + 1] = Math.round(linearToSrgb(gLin) * 255)
          pixels[outIdx + 2] = Math.round(linearToSrgb(bLin) * 255)
          pixels[outIdx + 3] = 255
        }
      }
    }
  }

  return { width, height, pixels }
}
