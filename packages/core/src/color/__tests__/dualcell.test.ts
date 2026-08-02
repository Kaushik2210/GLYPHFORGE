import { describe, expect, it } from 'vitest'
import { solveDualCell, dualCellMaskAsTile } from '../dualcell.js'
import type { Oklab } from '../oklab.js'

describe('solveDualCell', () => {
  it('separates a hard two-tone split into two clusters with high separation', () => {
    const dark: Oklab = { L: 0.1, a: 0, b: 0 }
    const bright: Oklab = { L: 0.9, a: 0, b: 0 }
    const pixels: Oklab[] = [dark, dark, dark, bright, bright, bright]
    const result = solveDualCell(pixels)
    expect(result.separation).toBeGreaterThan(0.5)
    expect(result.c1.L).toBeGreaterThan(result.c0.L)
  })

  it('produces a mask consistent with the brighter/darker split', () => {
    const dark: Oklab = { L: 0.1, a: 0, b: 0 }
    const bright: Oklab = { L: 0.9, a: 0, b: 0 }
    const pixels: Oklab[] = [dark, dark, bright, bright]
    const result = solveDualCell(pixels)
    expect(Array.from(result.mask)).toEqual([0, 0, 1, 1])
  })

  it('reports near-zero separation for a flat cell', () => {
    const pixels: Oklab[] = new Array(8).fill({ L: 0.5, a: 0.02, b: -0.01 })
    const result = solveDualCell(pixels)
    expect(result.separation).toBeCloseTo(0, 6)
  })

  it('is deterministic (invariant #4: no randomness)', () => {
    const pixels: Oklab[] = [
      { L: 0.2, a: 0.1, b: 0 },
      { L: 0.8, a: -0.1, b: 0.05 },
      { L: 0.3, a: 0, b: 0.02 },
      { L: 0.7, a: 0.02, b: -0.03 },
    ]
    const a = solveDualCell(pixels)
    const b = solveDualCell(pixels)
    expect(a.c0).toEqual(b.c0)
    expect(a.c1).toEqual(b.c1)
    expect(Array.from(a.mask)).toEqual(Array.from(b.mask))
  })

  it('throws on empty input', () => {
    expect(() => solveDualCell([])).toThrow()
  })
})

describe('dualCellMaskAsTile', () => {
  it('converts a Uint8Array mask to a Float32Array of 0/1', () => {
    const mask = new Uint8Array([0, 1, 1, 0])
    expect(Array.from(dualCellMaskAsTile(mask))).toEqual([0, 1, 1, 0])
  })
})
