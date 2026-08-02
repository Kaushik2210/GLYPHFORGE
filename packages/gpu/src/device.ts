/** Capability tiers — PLAN §1, §13. Tier 0 (cpu) never white-screens; it just drops features. */
export type CapabilityTier = 'webgpu' | 'webgl2' | 'cpu'

export interface CapabilityEnv {
  hasWebGPU: boolean
  hasWebGL2: boolean
}

/** Pure decision function, testable in node without a real browser. */
export function detectCapabilityTier(env: CapabilityEnv): CapabilityTier {
  if (env.hasWebGPU) return 'webgpu'
  if (env.hasWebGL2) return 'webgl2'
  return 'cpu'
}

/** Probes the actual browser environment. Only meaningful in a DOM context. */
export function probeBrowserEnv(): CapabilityEnv {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator
  let hasWebGL2 = false
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    hasWebGL2 = canvas.getContext('webgl2') !== null
  }
  return { hasWebGPU, hasWebGL2 }
}
