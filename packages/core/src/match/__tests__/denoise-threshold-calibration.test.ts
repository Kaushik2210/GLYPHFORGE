import { describe, expect, it } from 'vitest'
import { gaussianBlur } from '../../edge/fields.js'
import { linearToOklab } from '../../color/oklab.js'
import { solveDualCell } from '../../color/dualcell.js'
import { tileConfidence } from '../cost.js'
import type { Oklab } from '../../color/oklab.js'

/**
 * Regression test for the calibration behind FLAT_TILE_STD_THRESHOLD (cost.ts) and
 * DUAL_CELL_SEPARATION_THRESHOLD (apps/web/src/App.tsx, mirrored here as a plain
 * constant since it's UI-layer state cost.ts doesn't import).
 *
 * Both thresholds were originally tuned to defeat noise/moire measured *before*
 * App.tsx's denoise blur (gaussianBlur, sigma=2.5) existed in the pipeline, which left
 * far more margin than the (already-denoised) data needs — enough to also flatten real
 * edges and texture, which is what "photo clarity got worse" traced back to. This test
 * measures the same signal the thresholds gate — post-denoise, matching what App.tsx's
 * imageToGlyphField actually feeds the matcher — so a future re-tune has a concrete
 * noise-floor-vs-signal baseline instead of re-deriving it from scratch.
 */
const CELL_W = 8
const CELL_H = 14
const DENOISE_SIGMA = 2.5
const DUAL_CELL_SEPARATION_THRESHOLD = 0.05 // mirrors apps/web/src/App.tsx
const FLAT_TILE_STD_THRESHOLD_RATIO = 6 // hardEdgeConfidence saturates at 1; margin is on the noise side

function measureSeparation(srcW: number, srcH: number, colorFn: (x: number, y: number) => [number, number, number]): number {
  const rRaw = new Float32Array(srcW * srcH)
  const gRaw = new Float32Array(srcW * srcH)
  const bRaw = new Float32Array(srcW * srcH)
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const [r, g, b] = colorFn(x, y)
      const p = y * srcW + x
      rRaw[p] = r
      gRaw[p] = g
      bRaw[p] = b
    }
  }
  const rBuf = gaussianBlur({ width: srcW, height: srcH, data: rRaw }, DENOISE_SIGMA).data
  const gBuf = gaussianBlur({ width: srcW, height: srcH, data: gRaw }, DENOISE_SIGMA).data
  const bBuf = gaussianBlur({ width: srcW, height: srcH, data: bRaw }, DENOISE_SIGMA).data
  // Measure one cell in the middle of the field, away from edge-blur artifacts.
  const cx = Math.floor(srcW / CELL_W / 2)
  const cy = Math.floor(srcH / CELL_H / 2)
  const pixelPool: Oklab[] = []
  for (let py = 0; py < CELL_H; py++) {
    const srcY = cy * CELL_H + py
    for (let px = 0; px < CELL_W; px++) {
      const srcX = cx * CELL_W + px
      const p = srcY * srcW + srcX
      pixelPool.push(linearToOklab({ r: rBuf[p] ?? 0, g: gBuf[p] ?? 0, b: bBuf[p] ?? 0 }))
    }
  }
  return solveDualCell(pixelPool).separation
}

function measureTileConfidence(W: number, H: number, colorFn: (x: number, y: number) => number): number {
  const raw = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) raw[y * W + x] = colorFn(x, y)
  }
  const blurred = gaussianBlur({ width: W, height: H, data: raw }, DENOISE_SIGMA).data
  const cx = Math.floor(W / CELL_W / 2)
  const cy = Math.floor(H / CELL_H / 2)
  const tile = new Float32Array(CELL_W * CELL_H)
  let t = 0
  for (let py = 0; py < CELL_H; py++) {
    const srcY = cy * CELL_H + py
    for (let px = 0; px < CELL_W; px++) {
      const srcX = cx * CELL_W + px
      tile[t++] = blurred[srcY * W + srcX] ?? 0
    }
  }
  return tileConfidence(tile)
}

describe('post-denoise threshold calibration', () => {
  const W = 256
  const H = 256

  it('dual-cell: ordered-dither noise and smooth gradients stay well below threshold', () => {
    const dithered = measureSeparation(W, H, (x, y) => {
      const bit = (x + y) % 2 === 0 ? 0.52 : 0.48
      return [bit, bit, bit]
    })
    const gentle = measureSeparation(W, H, (x) => {
      const t = x / W
      return [0.4 + 0.05 * t, 0.4 + 0.05 * t, 0.4 + 0.05 * t]
    })
    const steep = measureSeparation(W, H, (x) => {
      const t = x / W
      return [0.1 + 0.8 * t, 0.1 + 0.8 * t, 0.1 + 0.8 * t]
    })

    expect(dithered).toBe(0)
    expect(gentle).toBeLessThan(DUAL_CELL_SEPARATION_THRESHOLD / 10)
    expect(steep).toBeLessThan(DUAL_CELL_SEPARATION_THRESHOLD)
  })

  it('dual-cell: a real hard edge clears the threshold with margin to spare', () => {
    const hardEdge = measureSeparation(W, H, (x) => (x < W / 2 ? [0.9, 0.85, 0.2] : [0.1, 0.05, 0.4]))
    expect(hardEdge).toBeGreaterThan(DUAL_CELL_SEPARATION_THRESHOLD * 3)
  })

  it('single-tone fallback: dither and gentle gradients barely engage the structure term', () => {
    const dithered = measureTileConfidence(W, H, (x, y) => ((x + y) % 2 === 0 ? 0.52 : 0.48))
    const gentle = measureTileConfidence(W, H, (x) => 0.4 + 0.05 * (x / W))

    expect(dithered).toBe(0)
    expect(gentle).toBeLessThan(1 / FLAT_TILE_STD_THRESHOLD_RATIO)
  })

  it('single-tone fallback: a real hard edge saturates the structure term', () => {
    const hardEdge = measureTileConfidence(W, H, (x) => (x < W / 2 ? 0.85 : 0.15))
    expect(hardEdge).toBe(1)
  })
})
