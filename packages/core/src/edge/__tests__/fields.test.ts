import { describe, expect, it } from 'vitest'
import { gaussianBlur, differenceOfGaussians, sobel, type LumaField } from '../fields.js'

function checkerboard(width: number, height: number): LumaField {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (x + y) % 2 === 0 ? 1 : 0
    }
  }
  return { width, height, data }
}

function flat(width: number, height: number, value = 0.5): LumaField {
  return { width, height, data: new Float32Array(width * height).fill(value) }
}

function verticalHalfSplit(width: number, height: number): LumaField {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = x < width / 2 ? 0 : 1
    }
  }
  return { width, height, data }
}

describe('gaussianBlur', () => {
  it('reduces high-frequency variance (smooths a checkerboard toward its mean)', () => {
    const field = checkerboard(16, 16)
    const blurred = gaussianBlur(field, 2)
    const mean = 0.5
    let rawVar = 0
    let blurredVar = 0
    for (let i = 0; i < field.data.length; i++) {
      rawVar += ((field.data[i] ?? 0) - mean) ** 2
      blurredVar += ((blurred.data[i] ?? 0) - mean) ** 2
    }
    expect(blurredVar).toBeLessThan(rawVar)
  })

  it('is a no-op for sigma <= 0', () => {
    const field = checkerboard(8, 8)
    const result = gaussianBlur(field, 0)
    expect(Array.from(result.data)).toEqual(Array.from(field.data))
  })

  it('leaves a flat field flat', () => {
    const field = flat(10, 10, 0.7)
    const blurred = gaussianBlur(field, 1.5)
    for (const v of blurred.data) expect(v).toBeCloseTo(0.7, 5)
  })
})

describe('differenceOfGaussians', () => {
  it('cancels exactly on a flat field when tau=1 (both blurs converge to the same constant)', () => {
    const field = flat(12, 12, 0.4)
    const dog = differenceOfGaussians(field, 1.0, 1.0)
    for (const v of dog.data) expect(Math.abs(v)).toBeLessThan(1e-4)
  })

  it('with the default tau (0.98) a flat field leaves a small residual proportional to brightness, not zero', () => {
    const field = flat(12, 12, 0.4)
    const dog = differenceOfGaussians(field, 1.0)
    const expectedResidual = 0.4 * (1 - 0.98)
    for (const v of dog.data) expect(v).toBeCloseTo(expectedResidual, 5)
  })

  it('has larger magnitude near a hard edge than far from it', () => {
    const field = verticalHalfSplit(20, 20)
    const dog = differenceOfGaussians(field, 1.0)
    const nearEdge = Math.abs(dog.data[20 * 10 + 10] ?? 0)
    const farFromEdge = Math.abs(dog.data[20 * 10 + 1] ?? 0)
    expect(nearEdge).toBeGreaterThan(farFromEdge)
  })
})

describe('sobel', () => {
  it('reports near-zero magnitude on a flat field', () => {
    const grad = sobel(flat(10, 10))
    for (const m of grad.magnitude) expect(m).toBeCloseTo(0, 5)
  })

  it('reports high magnitude at a vertical edge, oriented along x', () => {
    const grad = sobel(verticalHalfSplit(20, 20))
    const idx = 20 * 10 + 10 // right at the boundary column
    expect(grad.magnitude[idx] ?? 0).toBeGreaterThan(1)
    expect(Math.abs(grad.gx[idx] ?? 0)).toBeGreaterThan(Math.abs(grad.gy[idx] ?? 0))
  })
})
