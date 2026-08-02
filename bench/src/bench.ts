/**
 * Phase 0 perf bench. The real budgeted operations in PLAN.md §11.3 (glyphify, matcher,
 * optical flow, fluid sim) don't exist yet — those land with their respective phases and
 * get their own baseline entries then. This script exercises what Phase 0 actually built
 * (GlyphField ops, the CPU reference renderer, RLE delta) so `pnpm bench` is meaningful
 * from day one instead of a placeholder that always passes.
 */
import {
  GlyphField,
  encodeDelta,
  renderGlyphFieldCpu,
  prepareGlyphs,
  matchGlyphFast,
  WEIGHTS_TECHNICAL,
  type GlyphBitmapProvider,
  type GlyphCandidate,
} from '@glyphforge/core'

interface BenchResult {
  name: string
  ms: number
}

function time(name: string, fn: () => void, iterations: number): BenchResult {
  // warm up
  for (let i = 0; i < Math.min(3, iterations); i++) fn()
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn()
  const end = process.hrtime.bigint()
  const totalMs = Number(end - start) / 1e6
  return { name, ms: totalMs / iterations }
}

function checkerboardAtlas(cellW: number, cellH: number): GlyphBitmapProvider {
  return {
    cellW,
    cellH,
    getBitmap: () => {
      const bmp = new Float32Array(cellW * cellH)
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          bmp[y * cellW + x] = (x + y) % 2 === 0 ? 1 : 0
        }
      }
      return bmp
    },
  }
}

function main(): void {
  const cols = 240
  const rows = 135
  const field = new GlyphField(cols, rows)
  field.fill({ ch: 1, fg: 0xffffffff, bg: 0xff000000, flags: 0 })
  const atlas = checkerboardAtlas(8, 16)

  const results: BenchResult[] = []

  results.push(
    time(
      'GlyphField construct+fill 240x135',
      () => {
        const f = new GlyphField(cols, rows)
        f.fill({ ch: 1, fg: 0xffffffff, bg: 0xff000000, flags: 0 })
      },
      50,
    ),
  )

  results.push(time('renderGlyphFieldCpu 240x135 (8x16 cells)', () => renderGlyphFieldCpu(field, atlas), 20))

  const prev = field.clone()
  const curr = field.clone()
  curr.set(10, 10, { ch: 2 })
  curr.set(11, 10, { ch: 2 })
  results.push(time('encodeDelta 240x135, 2 changed cells', () => encodeDelta(prev, curr), 200))

  // Simulates one full image->ASCII conversion pass (apps/web imageToGlyphField): a
  // 110x47 grid (a typical single-image output) matched against a ~70-glyph charset,
  // 8x14 cell bitmaps. This is what matchGlyphFast (packages/core/src/match/match.ts)
  // exists to make cheap — see the fix that motivated it.
  const cellW = 8
  const cellH = 14
  const glyphCount = 70
  const candidates: GlyphCandidate[] = []
  for (let i = 0; i < glyphCount; i++) {
    const bitmap = new Float32Array(cellW * cellH)
    for (let p = 0; p < bitmap.length; p++) bitmap[p] = ((p + i * 7) % (i + 3)) / (i + 3)
    let sum = 0
    for (let p = 0; p < bitmap.length; p++) sum += bitmap[p] ?? 0
    candidates.push({ index: i, bitmap, coverage: sum / bitmap.length })
  }
  const prepared = prepareGlyphs(candidates)
  const matchCols = 110
  const matchRows = 47
  const tile = new Float32Array(cellW * cellH)
  for (let p = 0; p < tile.length; p++) tile[p] = (p % 5) / 5

  results.push(
    time(
      `matchGlyphFast full conversion pass (${matchCols}x${matchRows} cells x ${glyphCount} glyphs)`,
      () => {
        for (let i = 0; i < matchCols * matchRows; i++) {
          matchGlyphFast(tile, prepared, WEIGHTS_TECHNICAL)
        }
      },
      5,
    ),
  )

  console.log('\nGLYPHFORGE bench — Phase 0\n')
  console.log('op'.padEnd(45), 'ms/iter')
  for (const r of results) {
    console.log(r.name.padEnd(45), r.ms.toFixed(4))
  }
  console.log('\n(These are placeholder Phase 0 measurements, not the PLAN.md §11.3 budgets — those apply from Phase 2 onward.)')
}

main()
