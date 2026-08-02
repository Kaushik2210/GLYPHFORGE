import { GlyphField } from './glyph-field.js'

/** A maximal run of consecutive cells (row-major index order) that changed between two frames. */
export interface DeltaSpan {
  start: number
  length: number
  ch: Uint16Array
  fg: Uint32Array
  bg: Uint32Array
  flags: Uint8Array
}

export interface FieldDelta {
  cols: number
  rows: number
  spans: DeltaSpan[]
}

/**
 * Encode curr relative to prev as RLE spans of changed cells.
 * A 500-frame animation with mostly-static regions costs O(changed cells), not O(cols*rows*frames) — invariant #9.
 */
export function encodeDelta(prev: GlyphField, curr: GlyphField): FieldDelta {
  if (prev.cols !== curr.cols || prev.rows !== curr.rows) {
    throw new Error('encodeDelta requires matching dimensions')
  }
  const spans: DeltaSpan[] = []
  const n = curr.length
  let i = 0
  while (i < n) {
    if (!cellDiffers(prev, curr, i)) {
      i++
      continue
    }
    const start = i
    while (i < n && cellDiffers(prev, curr, i)) i++
    const length = i - start
    spans.push({
      start,
      length,
      ch: curr.ch.slice(start, start + length),
      fg: curr.fg.slice(start, start + length),
      bg: curr.bg.slice(start, start + length),
      flags: curr.flags.slice(start, start + length),
    })
  }
  return { cols: curr.cols, rows: curr.rows, spans }
}

export function decodeDelta(prev: GlyphField, delta: FieldDelta): GlyphField {
  if (prev.cols !== delta.cols || prev.rows !== delta.rows) {
    throw new Error('decodeDelta requires matching dimensions')
  }
  const out = prev.clone()
  for (const span of delta.spans) {
    out.ch.set(span.ch, span.start)
    out.fg.set(span.fg, span.start)
    out.bg.set(span.bg, span.start)
    out.flags.set(span.flags, span.start)
  }
  return out
}

function cellDiffers(a: GlyphField, b: GlyphField, i: number): boolean {
  return a.ch[i] !== b.ch[i] || a.fg[i] !== b.fg[i] || a.bg[i] !== b.bg[i] || a.flags[i] !== b.flags[i]
}
