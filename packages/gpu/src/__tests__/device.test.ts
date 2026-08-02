import { describe, expect, it } from 'vitest'
import { detectCapabilityTier } from '../device.js'

describe('detectCapabilityTier', () => {
  it('prefers webgpu when available', () => {
    expect(detectCapabilityTier({ hasWebGPU: true, hasWebGL2: true })).toBe('webgpu')
    expect(detectCapabilityTier({ hasWebGPU: true, hasWebGL2: false })).toBe('webgpu')
  })

  it('falls back to webgl2', () => {
    expect(detectCapabilityTier({ hasWebGPU: false, hasWebGL2: true })).toBe('webgl2')
  })

  it('falls back to cpu tier, never nothing (PLAN §13: never white-screen)', () => {
    expect(detectCapabilityTier({ hasWebGPU: false, hasWebGL2: false })).toBe('cpu')
  })
})
