/**
 * Global (non-windowed) grayscale SSIM. PLAN.md §11.1's fidelity harness upgrades this to
 * a windowed SSIM (and adds MS-SSIM / gradient-domain / temporal variants) once Phase 2
 * wires up the real glyphify -> re-render pipeline this compares against.
 */
const K1 = 0.01
const K2 = 0.03
const L = 255 // dynamic range for 8-bit grayscale

export function ssim(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) throw new Error('ssim requires equal-length inputs')
  const n = a.length
  const C1 = (K1 * L) ** 2
  const C2 = (K2 * L) ** 2

  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i++) {
    meanA += a[i] ?? 0
    meanB += b[i] ?? 0
  }
  meanA /= n
  meanB /= n

  let varA = 0
  let varB = 0
  let covAB = 0
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA
    const db = (b[i] ?? 0) - meanB
    varA += da * da
    varB += db * db
    covAB += da * db
  }
  varA /= n - 1
  varB /= n - 1
  covAB /= n - 1

  const numerator = (2 * meanA * meanB + C1) * (2 * covAB + C2)
  const denominator = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2)
  return numerator / denominator
}
