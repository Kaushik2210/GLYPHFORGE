import { describe, expect, it } from 'vitest'
import { gaussianBlur } from '../../edge/fields.js'
import { linearToOklab } from '../../color/oklab.js'
import { solveDualCell } from '../../color/dualcell.js'
import { tileConfidence } from '../cost.js'
import type { Oklab } from '../../color/oklab.js'

/**
 * Regression test for the calibration behind three constants that all interact:
 * DENOISE_SIGMA and DUAL_CELL_SEPARATION_THRESHOLD (apps/web/src/App.tsx, mirrored here
 * as plain constants since they're UI-layer state cost.ts doesn't import) and
 * FLAT_TILE_STD_THRESHOLD (cost.ts, imported directly).
 *
 * History: the thresholds were originally tuned (0.06->0.18, 0.025->0.09) to defeat
 * noise/moire measured *before* App.tsx's denoise blur existed in the pipeline, which
 * left far more margin than needed once the blur existed — enough to also flatten real
 * edges and texture ("photo clarity got worse"). Recalibrating the thresholds against
 * the post-denoise noise floor fixed that (0.18->0.05, 0.09->0.03) without touching the
 * blur itself.
 *
 * But the blur (DENOISE_SIGMA) doesn't just gate glyph-shape selection — it directly
 * produces the fg/bg colors actually displayed (App.tsx feeds rBuf/gBuf/bBuf, the
 * blurred buffers, into both the matcher AND the per-cell color average). A sigma tuned
 * against the *old* thresholds was blurring away real fine-scale color detail (e.g. a
 * cluster of small faces in a crowd photo) that the recalibrated thresholds could
 * otherwise have captured. Lowered 2.5->1.0, re-measured against realistic-amplitude
 * noise (not the worst-case 1px-period/±0.02 synthetic swing the original tuning used)
 * rather than guessed.
 */
const CELL_W = 8
const CELL_H = 14
const DENOISE_SIGMA = 1.0 // mirrors apps/web/src/App.tsx
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

// Ordered dithering perturbs which of two adjacent representable values a pixel rounds
// to - roughly 1 LSB of an 8-bit channel (~1/255 in [0,1]), not a visible swing. Period
// 8 matches CELL_W (and the Bayer block size the original moire bug traced to); a 1px
// checkerboard (the original probe's shape) is a much higher, much-easier-to-blur-away
// frequency and understates how much of this survives a given sigma.
function orderedDither8(x: number, y: number): number {
  return (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 0.504 : 0.496
}

// Deterministic pseudo-random noise (not Math.random - keeps the test reproducible),
// scaled to ~1% std to approximate real sensor/JPEG noise.
function sensorNoise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return 0.5 + ((n - Math.floor(n)) - 0.5) * 0.02
}

describe('post-denoise threshold calibration', () => {
  const W = 256
  const H = 256

  it('dual-cell: realistic dither/sensor noise and smooth gradients stay well below threshold', () => {
    const dithered = measureSeparation(W, H, (x, y) => {
      const v = orderedDither8(x, y)
      return [v, v, v]
    })
    const noisy = measureSeparation(W, H, (x, y) => {
      const v = sensorNoise(x, y)
      return [v, v, v]
    })
    const gentle = measureSeparation(W, H, (x) => {
      const t = x / W
      return [0.4 + 0.05 * t, 0.4 + 0.05 * t, 0.4 + 0.05 * t]
    })
    const steep = measureSeparation(W, H, (x) => {
      const t = x / W
      return [0.1 + 0.8 * t, 0.1 + 0.8 * t, 0.1 + 0.8 * t]
    })

    expect(dithered).toBeLessThan(DUAL_CELL_SEPARATION_THRESHOLD / 10)
    expect(noisy).toBeLessThan(DUAL_CELL_SEPARATION_THRESHOLD / 10)
    expect(gentle).toBeLessThan(DUAL_CELL_SEPARATION_THRESHOLD / 10)
    expect(steep).toBeLessThan(DUAL_CELL_SEPARATION_THRESHOLD)
  })

  it('dual-cell: a real hard edge clears the threshold with margin to spare', () => {
    const hardEdge = measureSeparation(W, H, (x) => (x < W / 2 ? [0.9, 0.85, 0.2] : [0.1, 0.05, 0.4]))
    expect(hardEdge).toBeGreaterThan(DUAL_CELL_SEPARATION_THRESHOLD * 3)
  })

  it('dual-cell: fine detail below the OLD sigma survives at the current one', () => {
    // A scattered-small-dot pattern - the "cluster of small faces in a crowd photo"
    // shape that was flattening to a single averaged tone even after the threshold
    // recalibration, because sigma=2.5 was blurring the signal away before it was ever
    // measured. This is the concrete case DENOISE_SIGMA 2.5->1.0 was lowered for.
    const fineDetail = measureSeparation(W, H, (x, y) => {
      const cellX = Math.floor(x / 10)
      const cellY = Math.floor(y / 10)
      const isDot = (cellX * 7 + cellY * 13) % 5 === 0 && x % 10 < 4 && y % 10 < 4
      return isDot ? [0.8, 0.5, 0.3] : [0.5, 0.5, 0.55]
    })
    expect(fineDetail).toBeGreaterThan(DUAL_CELL_SEPARATION_THRESHOLD)
  })

  it('single-tone fallback: dither, sensor noise, and gentle gradients barely engage the structure term', () => {
    const dithered = measureTileConfidence(W, H, orderedDither8)
    const noisy = measureTileConfidence(W, H, sensorNoise)
    const gentle = measureTileConfidence(W, H, (x) => 0.4 + 0.05 * (x / W))

    expect(dithered).toBeLessThan(1 / FLAT_TILE_STD_THRESHOLD_RATIO)
    expect(noisy).toBeLessThan(1 / FLAT_TILE_STD_THRESHOLD_RATIO)
    expect(gentle).toBeLessThan(1 / FLAT_TILE_STD_THRESHOLD_RATIO)
  })

  it('single-tone fallback: a real hard edge saturates the structure term', () => {
    const hardEdge = measureTileConfidence(W, H, (x) => (x < W / 2 ? 0.85 : 0.15))
    expect(hardEdge).toBe(1)
  })
})
