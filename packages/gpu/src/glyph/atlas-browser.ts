import type { GlyphCandidate } from '@glyphforge/core'

/**
 * Browser-only glyph atlas rasterizer — PLAN §3.1. Lives in `gpu`, not `core`, because it
 * needs Canvas2D (DOM); `core`'s matcher only depends on the resulting Float32Array
 * bitmaps, never on how they were produced (invariant: core is zero-DOM, testable in node).
 */
export interface RasterizedGlyph extends GlyphCandidate {
  codepoint: number
}

export interface GlyphAtlas {
  cellW: number
  cellH: number
  glyphs: RasterizedGlyph[]
  texture: WebGLTexture
  stripWidth: number
  stripHeight: number
}

/** Supersample factor for rasterization — PLAN §3.1: glyph edges hold the detail.
 * 6x rather than the plan's baseline 4x: box-downsampling from a higher-res source
 * gives noticeably smoother anti-aliased edges at typical cell sizes (8x14). */
const SUPERSAMPLE = 6

export function rasterizeCharset(
  codepoints: readonly number[],
  fontFamily: string,
  cellW: number,
  cellH: number,
): RasterizedGlyph[] {
  const ssW = cellW * SUPERSAMPLE
  const ssH = cellH * SUPERSAMPLE
  const canvas = document.createElement('canvas')
  canvas.width = ssW
  canvas.height = ssH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D context unavailable')

  const fontSize = ssH * 0.78
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.font = `${fontSize}px ${fontFamily}`

  const glyphs: RasterizedGlyph[] = []
  for (let i = 0; i < codepoints.length; i++) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, ssW, ssH)
    ctx.fillStyle = '#fff'
    ctx.fillText(String.fromCodePoint(codepoints[i] ?? 0x20), ssW / 2, ssH / 2 + 1)
    const rgba = ctx.getImageData(0, 0, ssW, ssH).data
    const bitmap = boxDownsample(rgba, ssW, ssH, cellW, cellH)
    let sum = 0
    for (let p = 0; p < bitmap.length; p++) sum += bitmap[p] ?? 0
    glyphs.push({ index: i, codepoint: codepoints[i] ?? 0x20, bitmap, coverage: sum / bitmap.length })
  }
  return glyphs
}

function boxDownsample(rgba: Uint8ClampedArray, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
  const out = new Float32Array(dstW * dstH)
  const scaleX = srcW / dstW
  const scaleY = srcH / dstH
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * scaleY)
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * scaleY))
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * scaleX)
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * scaleX))
      let sum = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += (rgba[(sy * srcW + sx) * 4] ?? 0) / 255
          count++
        }
      }
      out[dy * dstW + dx] = count > 0 ? sum / count : 0
    }
  }
  return out
}

function buildAtlasTexture(
  gl: WebGL2RenderingContext,
  glyphs: readonly RasterizedGlyph[],
  cellW: number,
  cellH: number,
): { texture: WebGLTexture; stripWidth: number; stripHeight: number } {
  const stripWidth = glyphs.length * cellW
  const stripHeight = cellH
  const data = new Uint8Array(stripWidth * stripHeight)
  for (const glyph of glyphs) {
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        data[y * stripWidth + glyph.index * cellW + x] = Math.round((glyph.bitmap[y * cellW + x] ?? 0) * 255)
      }
    }
  }

  const texture = gl.createTexture()
  if (!texture) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, stripWidth, stripHeight, 0, gl.RED, gl.UNSIGNED_BYTE, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return { texture, stripWidth, stripHeight }
}

export function createGlyphAtlas(
  gl: WebGL2RenderingContext,
  codepoints: readonly number[],
  fontFamily: string,
  cellW: number,
  cellH: number,
): GlyphAtlas {
  const glyphs = rasterizeCharset(codepoints, fontFamily, cellW, cellH)
  const { texture, stripWidth, stripHeight } = buildAtlasTexture(gl, glyphs, cellW, cellH)
  return { cellW, cellH, glyphs, texture, stripWidth, stripHeight }
}
