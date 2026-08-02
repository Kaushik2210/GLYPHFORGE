import type { GlyphField } from '../field/glyph-field.js'
import { unpackRgba8 } from '../color/oklab.js'

/**
 * Plain-text export — PLAN §9.3 `.txt`. `codepoints` maps a GlyphField's `ch` index
 * (an atlas slot, invariant #6) to the actual Unicode codepoint; core has no opinion
 * on font/atlas, so callers (ui/gpu) supply the lookup.
 */
export function fieldToText(field: GlyphField, codepoints: readonly number[]): string {
  const rows: string[] = []
  for (let y = 0; y < field.rows; y++) {
    let row = ''
    for (let x = 0; x < field.cols; x++) {
      const chIndex = field.ch[field.index(x, y)] ?? 0
      row += String.fromCodePoint(codepoints[chIndex] ?? 0x20)
    }
    rows.push(row)
  }
  return rows.join('\n')
}

const ESC = '['
const RESET = `${ESC}0m`

/** 24-bit truecolor ANSI export — PLAN §9.3 `.ans`. Color codes only emitted on change. */
export function fieldToAnsi(field: GlyphField, codepoints: readonly number[]): string {
  const lines: string[] = []
  for (let y = 0; y < field.rows; y++) {
    let line = ''
    let lastFg = -1
    let lastBg = -1
    for (let x = 0; x < field.cols; x++) {
      const i = field.index(x, y)
      const chIndex = field.ch[i] ?? 0
      const fg = field.fg[i] ?? 0xffffffff
      const bg = field.bg[i] ?? 0
      if (fg !== lastFg || bg !== lastBg) {
        const f = unpackRgba8(fg)
        const b = unpackRgba8(bg)
        line += `${ESC}38;2;${f.r};${f.g};${f.b}m${ESC}48;2;${b.r};${b.g};${b.b}m`
        lastFg = fg
        lastBg = bg
      }
      line += String.fromCodePoint(codepoints[chIndex] ?? 0x20)
    }
    line += RESET
    lines.push(line)
  }
  return lines.join('\n')
}
