/**
 * DoG + Sobel — PLAN §5.1 (Acerola-style edge pass, extended with structure-tensor
 * coherence in cell.ts). Pure CPU reference: operates on a plain luminance grid, no
 * DOM, no WebGPU — the WGSL passes (gpu/passes/dog.wgsl, sobel.wgsl) are Phase 6+ work
 * and get parity-tested against this per invariant #5.
 */
export interface LumaField {
  width: number
  height: number
  data: Float32Array
}

function clampIndex(i: number, size: number): number {
  return i < 0 ? 0 : i >= size ? size - 1 : i
}

function gaussianKernel1D(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const size = radius * 2 + 1
  const kernel = new Float32Array(size)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < size; i++) kernel[i] = (kernel[i] ?? 0) / sum
  return kernel
}

/** Separable Gaussian blur, clamp-to-edge boundary. */
export function gaussianBlur(field: LumaField, sigma: number): LumaField {
  const { width, height, data } = field
  if (sigma <= 0) return { width, height, data: data.slice() }

  const kernel = gaussianKernel1D(sigma)
  const radius = (kernel.length - 1) / 2

  const horiz = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const sx = clampIndex(x + k, width)
        sum += (data[y * width + sx] ?? 0) * (kernel[k + radius] ?? 0)
      }
      horiz[y * width + x] = sum
    }
  }

  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const sy = clampIndex(y + k, height)
        sum += (horiz[sy * width + x] ?? 0) * (kernel[k + radius] ?? 0)
      }
      out[y * width + x] = sum
    }
  }
  return { width, height, data: out }
}

/** DoG = G(sigma1) - tau*G(1.6*sigma1). tau~0.98 per PLAN §5.1. */
export function differenceOfGaussians(field: LumaField, sigma1: number, tau = 0.98): LumaField {
  const sigma2 = sigma1 * 1.6
  const g1 = gaussianBlur(field, sigma1)
  const g2 = gaussianBlur(field, sigma2)
  const out = new Float32Array(field.width * field.height)
  for (let i = 0; i < out.length; i++) {
    out[i] = (g1.data[i] ?? 0) - tau * (g2.data[i] ?? 0)
  }
  return { width: field.width, height: field.height, data: out }
}

export interface GradientField {
  width: number
  height: number
  gx: Float32Array
  gy: Float32Array
  magnitude: Float32Array
}

/** 3x3 Sobel operator, clamp-to-edge boundary. */
export function sobel(field: LumaField): GradientField {
  const { width, height, data } = field
  const gx = new Float32Array(width * height)
  const gy = new Float32Array(width * height)
  const magnitude = new Float32Array(width * height)

  const at = (x: number, y: number): number => data[clampIndex(y, height) * width + clampIndex(x, width)] ?? 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gxVal =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
      const gyVal =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
      const idx = y * width + x
      gx[idx] = gxVal
      gy[idx] = gyVal
      magnitude[idx] = Math.sqrt(gxVal * gxVal + gyVal * gyVal)
    }
  }
  return { width, height, gx, gy, magnitude }
}
