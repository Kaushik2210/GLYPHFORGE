/**
 * Fidelity harness — PLAN.md §11.1. Full form: source image -> glyphify -> GlyphField
 * -> renderGlyphFieldCpu -> SSIM vs source, run over fixtures/. The matcher (Phase 2)
 * doesn't exist yet, so this can't score real conversions today. It still runs two
 * useful things now: a self-test that the SSIM implementation is correct, and a scan
 * of fixtures/ so the harness has somewhere to plug in once glyphify lands.
 */
import { readdirSync, existsSync } from 'node:fs'
import { ssim } from './ssim.js'

function selfTest(): void {
  const n = 64 * 64
  const identical = new Float64Array(n)
  for (let i = 0; i < n; i++) identical[i] = (i * 37) % 256

  const identicalScore = ssim(identical, identical)
  if (Math.abs(identicalScore - 1) > 1e-9) {
    throw new Error(`SSIM self-test failed: identical images scored ${identicalScore}, expected 1`)
  }

  const noisy = new Float64Array(identical)
  for (let i = 0; i < n; i += 7) noisy[i] = 255 - (noisy[i] ?? 0)
  const noisyScore = ssim(identical, noisy)
  if (!(noisyScore < identicalScore)) {
    throw new Error('SSIM self-test failed: perturbed image did not score lower than identical')
  }

  console.log(`SSIM self-test OK (identical=${identicalScore.toFixed(6)}, perturbed=${noisyScore.toFixed(6)})`)
}

function scanFixtures(): void {
  const dir = '../fixtures'
  if (!existsSync(dir)) {
    console.log('\nfixtures/ does not exist yet — nothing to score. See PLAN.md §11.1.')
    return
  }
  const entries = readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
  if (entries.length === 0) {
    console.log('\nfixtures/ has no images yet. Add the corpus from PLAN.md §11.2 (portraits, landscapes, ' +
      'text/screenshots, line art, high-frequency texture, low/high contrast) once Phase 2 lands the matcher.')
    return
  }
  console.log(`\nFound ${entries.length} fixture(s): ${entries.join(', ')}`)
  console.log('Scoring is wired up once glyphify (Phase 2) exists — tracked, not implemented yet.')
}

function main(): void {
  console.log('GLYPHFORGE fidelity harness — Phase 0\n')
  selfTest()
  scanFixtures()
}

main()
