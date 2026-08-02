/** SoA cell grid — invariant #6. Never refactor into an array of cell objects. */
export interface Cell {
  ch: number
  fg: number
  bg: number
  flags: number
}

export const FLAG_NONE = 0
export const FLAG_DUAL_COLOR = 1 << 0
export const FLAG_LOCKED = 1 << 1

export class GlyphField {
  readonly cols: number
  readonly rows: number
  readonly ch: Uint16Array
  readonly fg: Uint32Array
  readonly bg: Uint32Array
  readonly flags: Uint8Array

  constructor(cols: number, rows: number) {
    if (cols <= 0 || rows <= 0) {
      throw new Error(`GlyphField dims must be positive, got ${cols}x${rows}`)
    }
    this.cols = cols
    this.rows = rows
    const n = cols * rows
    this.ch = new Uint16Array(n)
    this.fg = new Uint32Array(n).fill(0xffffffff)
    this.bg = new Uint32Array(n)
    this.flags = new Uint8Array(n)
  }

  get length(): number {
    return this.cols * this.rows
  }

  index(x: number, y: number): number {
    return y * this.cols + x
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows
  }

  get(x: number, y: number): Cell {
    const i = this.index(x, y)
    return { ch: this.ch[i] ?? 0, fg: this.fg[i] ?? 0, bg: this.bg[i] ?? 0, flags: this.flags[i] ?? 0 }
  }

  set(x: number, y: number, cell: Partial<Cell>): void {
    const i = this.index(x, y)
    if (cell.ch !== undefined) this.ch[i] = cell.ch
    if (cell.fg !== undefined) this.fg[i] = cell.fg
    if (cell.bg !== undefined) this.bg[i] = cell.bg
    if (cell.flags !== undefined) this.flags[i] = cell.flags
  }

  fill(cell: Cell): void {
    this.ch.fill(cell.ch)
    this.fg.fill(cell.fg)
    this.bg.fill(cell.bg)
    this.flags.fill(cell.flags)
  }

  clone(): GlyphField {
    const out = new GlyphField(this.cols, this.rows)
    out.ch.set(this.ch)
    out.fg.set(this.fg)
    out.bg.set(this.bg)
    out.flags.set(this.flags)
    return out
  }

  /** Resize preserving the overlapping top-left region; new cells are blank. */
  resized(cols: number, rows: number): GlyphField {
    const out = new GlyphField(cols, rows)
    const copyCols = Math.min(cols, this.cols)
    const copyRows = Math.min(rows, this.rows)
    for (let y = 0; y < copyRows; y++) {
      for (let x = 0; x < copyCols; x++) {
        out.set(x, y, this.get(x, y))
      }
    }
    return out
  }

  equals(other: GlyphField): boolean {
    if (this.cols !== other.cols || this.rows !== other.rows) return false
    return (
      arraysEqual(this.ch, other.ch) &&
      arraysEqual(this.fg, other.fg) &&
      arraysEqual(this.bg, other.bg) &&
      arraysEqual(this.flags, other.flags)
    )
  }
}

function arraysEqual(
  a: Uint16Array | Uint32Array | Uint8Array,
  b: Uint16Array | Uint32Array | Uint8Array,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
