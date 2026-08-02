/** Curated character sets — PLAN.md §3.1. Each is an ordered, deduplicated list of codepoints. */
export interface Charset {
  id: string
  label: string
  codepoints: readonly number[]
}

function cp(str: string): number[] {
  return Array.from(str, (c) => c.codePointAt(0) ?? 0)
}

function range(startInclusive: number, endInclusive: number): number[] {
  const out: number[] = []
  for (let c = startInclusive; c <= endInclusive; c++) out.push(c)
  return out
}

// Printable ASCII 0x20-0x7E — 95 glyphs.
const ASCII_FULL = range(0x20, 0x7e)

// Excludes glyphs that render inconsistently in narrow/hinted monospace fonts.
const ASCII_SAFE = cp(
  ' .\'"`,:;!i|lI/\\()[]{}-_~+=<>*^abcdefghjkmnopqrstuvwxyzABCDEFGHJKLMNOPQRSTUVWXYZ0123456789',
)

const BLOCKS = cp('▀▄█▌▐░▒▓▘▝▖▗▚▞')

// Unicode 13 sextants — 2x3 subpixel blocks, U+1FB00-U+1FB3B.
const SEXTANTS = range(0x1fb00, 0x1fb3b)

// Braille patterns, 2x4 dots per cell — U+2800-U+28FF, 256 glyphs.
const BRAILLE = range(0x2800, 0x28ff)

const BOX_DRAWING = cp('─│┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═║╭╮╯╰')

const DIRECTIONAL = cp('|/-\\_╱╲')

const SHADE = cp('░▒▓█')

// Full-width katakana, U+30A0-U+30FF.
const KATAKANA = range(0x30a0, 0x30ff)

const EMOJI_MONO = cp('★☆●○■□▲△◆◇♠♣♥♦☀☁☂☃✓✗')

export const CHARSETS: readonly Charset[] = [
  { id: 'ascii-full', label: 'ASCII (full)', codepoints: ASCII_FULL },
  { id: 'ascii-safe', label: 'ASCII (safe)', codepoints: ASCII_SAFE },
  { id: 'blocks', label: 'Blocks', codepoints: BLOCKS },
  { id: 'sextants', label: 'Sextants', codepoints: SEXTANTS },
  { id: 'braille', label: 'Braille', codepoints: BRAILLE },
  { id: 'box-drawing', label: 'Box Drawing', codepoints: BOX_DRAWING },
  { id: 'directional', label: 'Directional', codepoints: DIRECTIONAL },
  { id: 'shade', label: 'Shade', codepoints: SHADE },
  { id: 'katakana', label: 'Katakana', codepoints: KATAKANA },
  { id: 'emoji-mono', label: 'Emoji (mono)', codepoints: EMOJI_MONO },
]

export function getCharset(id: string): Charset {
  const found = CHARSETS.find((c) => c.id === id)
  if (!found) throw new Error(`Unknown charset: ${id}`)
  return found
}
