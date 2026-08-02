import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BANNED = [/\bMath\.random\s*\(/, /\bDate\.now\s*\(/, /\bperformance\.now\s*\(/]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('determinism (invariant #4)', () => {
  it('packages/core has no Math.random, Date.now, or performance.now', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8')
      for (const pattern of BANNED) {
        if (pattern.test(content)) offenders.push(`${file}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
