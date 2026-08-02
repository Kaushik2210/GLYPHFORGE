import type { GlyphField } from '../field/glyph-field.js'

/** §6.1 — Document model. Stub types for Phase 0; behavior lands in Phase 4. */
export interface MediaRef {
  id: string
  kind: 'image' | 'video'
}

export interface Transform {
  x: number
  y: number
  scale: number
  rotation: number
}

export type Layer =
  | { kind: 'raster'; id: string; frames: GlyphField[] }
  | { kind: 'source'; id: string; media: MediaRef; transform: Transform }
  | { kind: 'generator'; id: string; node: string }

export interface Timeline {
  fps: number
  frameCount: number
}

export interface Document {
  cols: number
  rows: number
  fps: number
  layers: Layer[]
  timeline: Timeline
}

export function createEmptyDocument(cols: number, rows: number, fps = 24): Document {
  return { cols, rows, fps, layers: [], timeline: { fps, frameCount: 0 } }
}
