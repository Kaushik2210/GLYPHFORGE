import { describe, expect, it } from 'vitest'
import { sobel, type LumaField } from '../fields.js'
import { computeCellEdge, classifyDirection } from '../cell.js'

function horizontalSplit(width: number, height: number): LumaField {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = y < height / 2 ? 0 : 1
    }
  }
  return { width, height, data }
}

function verticalSplit(width: number, height: number): LumaField {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = x < width / 2 ? 0 : 1
    }
  }
  return { width, height, data }
}

function checkerboard(width: number, height: number): LumaField {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (x + y) % 2 === 0 ? 1 : 0
    }
  }
  return { width, height, data }
}

describe('computeCellEdge + classifyDirection', () => {
  it('classifies a horizontal boundary as "-" with high coherence', () => {
    const grad = sobel(horizontalSplit(20, 20))
    const edge = computeCellEdge(grad, 0, 0, 20, 20)
    expect(edge.coherence).toBeGreaterThan(0.7)
    expect(classifyDirection(edge.angle)).toBe('-')
  })

  it('classifies a vertical boundary as "|" with high coherence', () => {
    const grad = sobel(verticalSplit(20, 20))
    const edge = computeCellEdge(grad, 0, 0, 20, 20)
    expect(edge.coherence).toBeGreaterThan(0.7)
    expect(classifyDirection(edge.angle)).toBe('|')
  })

  it('reports low coherence for noisy texture (a checkerboard has no single orientation)', () => {
    const grad = sobel(checkerboard(20, 20))
    const edge = computeCellEdge(grad, 0, 0, 20, 20)
    expect(edge.coherence).toBeLessThan(0.3)
  })

  it('a clean edge is more coherent than noisy texture at comparable magnitude', () => {
    const cleanEdge = computeCellEdge(sobel(verticalSplit(20, 20)), 0, 0, 20, 20)
    const noisy = computeCellEdge(sobel(checkerboard(20, 20)), 0, 0, 20, 20)
    expect(cleanEdge.coherence).toBeGreaterThan(noisy.coherence)
  })

  it('reports zero magnitude and coherence outside the grid bounds', () => {
    const grad = sobel(verticalSplit(10, 10))
    const edge = computeCellEdge(grad, 5, 5, 10, 10) // entirely out of bounds
    expect(edge.magnitude).toBe(0)
    expect(edge.coherence).toBe(0)
  })
})

describe('classifyDirection', () => {
  it('wraps periodically at pi', () => {
    expect(classifyDirection(0)).toBe('-')
    expect(classifyDirection(Math.PI)).toBe('-')
    expect(classifyDirection(-0.01)).toBe('-')
  })
})
