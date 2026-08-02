import { useEffect, useRef, useState, type ReactElement, type ChangeEvent } from 'react'
import {
  GlyphField,
  packRgba8,
  srgbToLinear,
  linearToSrgb,
  oklabToLinear,
  matchGlyphFast,
  prepareGlyphs,
  type MatchWeights,
  getCharset,
  type PreparedGlyph,
} from '@glyphforge/core'
import {
  probeBrowserEnv,
  detectCapabilityTier,
  createInstancedGridRenderer,
  createGlyphAtlas,
  type InstancedGridRenderer,
  type GlyphAtlas,
} from '@glyphforge/gpu'
import type { CapabilityTier } from '@glyphforge/gpu'

const CELL_W = 8
const CELL_H = 14
const COLS = 140
const FONT_FAMILY = 'ui-monospace, "JetBrains Mono", "IBM Plex Mono", monospace'
const CHARSET_ID = 'ascii-safe'

/**
 * Balanced for photographic clarity: tone dominant (so brightness reads correctly),
 * structure meaningful but not overriding (kicks in on real edges/texture — flat
 * regions no longer engage it at all, see tileConfidence in packages/core/match/cost.ts).
 */
const IMAGE_WEIGHTS: MatchWeights = { wStruct: 0.7, wTone: 1.0, wEdge: 0, wTemp: 0, wPrior: 0 }

/** Phase 0 demo pattern, shown until an image is loaded. UI layer: Math.now-driven animation is fine here. */
function paintPlasma(field: GlyphField, tSeconds: number): void {
  for (let y = 0; y < field.rows; y++) {
    for (let x = 0; x < field.cols; x++) {
      const u = x / field.cols
      const v = y / field.rows
      const L = 0.6 + 0.15 * Math.sin(u * 10 + tSeconds)
      const a = 0.15 * Math.sin(u * 8 - v * 6 + tSeconds * 1.3)
      const b = 0.15 * Math.cos(v * 8 + tSeconds * 0.7)
      const linear = oklabToLinear({ L, a, b })
      const r = Math.round(linearToSrgb(clamp01(linear.r)) * 255)
      const g = Math.round(linearToSrgb(clamp01(linear.g)) * 255)
      const bl = Math.round(linearToSrgb(clamp01(linear.b)) * 255)
      field.set(x, y, { ch: 0, bg: packRgba8(r, g, bl) })
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Linear-light luminance (Rec.709) — invariant #1: never weight raw sRGB channels. */
function linearLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Converts a loaded image into a GlyphField using the real matcher (structure + tone,
 * PLAN §4.1) — not a luminance ramp. Per invariant #10, the source is sampled at exactly
 * cell-bitmap resolution (cols*CELL_W x rows*CELL_H), so every glyph decision sees real
 * sub-cell detail instead of one averaged brightness value.
 */
function imageToGlyphField(img: HTMLImageElement, prepared: readonly PreparedGlyph[]): GlyphField {
  const cols = COLS
  const cellAspect = CELL_W / CELL_H
  // Preserve the image's display aspect ratio: rows*CELL_H / cols*CELL_W == imgH/imgW.
  const rows = Math.max(1, Math.round((img.height / img.width) * cols * cellAspect))

  const srcW = cols * CELL_W
  const srcH = rows * CELL_H
  const canvas = document.createElement('canvas')
  canvas.width = srcW
  canvas.height = srcH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  ctx.drawImage(img, 0, 0, srcW, srcH)
  const rgba = ctx.getImageData(0, 0, srcW, srcH).data

  // Auto-contrast: most photos don't use the full [0,1] luminance range, which collapses
  // many cells onto near-identical glyphs. Stretch luminance to full range before it drives
  // glyph selection — displayed color (fg, below) stays true to the source, unstretched.
  const pixelCount = srcW * srcH
  let lumaMin = Infinity
  let lumaMax = -Infinity
  const lumaBuf = new Float32Array(pixelCount)
  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 4
    const r = srgbToLinear((rgba[idx] ?? 0) / 255)
    const g = srgbToLinear((rgba[idx + 1] ?? 0) / 255)
    const b = srgbToLinear((rgba[idx + 2] ?? 0) / 255)
    const luma = linearLuma(r, g, b)
    lumaBuf[p] = luma
    if (luma < lumaMin) lumaMin = luma
    if (luma > lumaMax) lumaMax = luma
  }
  const lumaRange = Math.max(lumaMax - lumaMin, 1e-4)

  const field = new GlyphField(cols, rows)
  const tile = new Float32Array(CELL_W * CELL_H)
  const cellPixels = CELL_W * CELL_H

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let t = 0
      for (let py = 0; py < CELL_H; py++) {
        const srcY = cy * CELL_H + py
        for (let px = 0; px < CELL_W; px++) {
          const srcX = cx * CELL_W + px
          const p = srcY * srcW + srcX
          const idx = p * 4
          sumR += srgbToLinear((rgba[idx] ?? 0) / 255)
          sumG += srgbToLinear((rgba[idx + 1] ?? 0) / 255)
          sumB += srgbToLinear((rgba[idx + 2] ?? 0) / 255)
          tile[t++] = clamp01(((lumaBuf[p] ?? 0) - lumaMin) / lumaRange)
        }
      }
      const avgR = sumR / cellPixels
      const avgG = sumG / cellPixels
      const avgB = sumB / cellPixels
      const fgR = Math.round(linearToSrgb(clamp01(avgR)) * 255)
      const fgG = Math.round(linearToSrgb(clamp01(avgG)) * 255)
      const fgB = Math.round(linearToSrgb(clamp01(avgB)) * 255)

      const best = matchGlyphFast(tile, prepared, IMAGE_WEIGHTS)
      field.set(cx, cy, { ch: best.index, fg: packRgba8(fgR, fgG, fgB), bg: packRgba8(0, 0, 0) })
    }
  }
  return field
}

export function App(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<InstancedGridRenderer | null>(null)
  const atlasRef = useRef<GlyphAtlas | null>(null)
  const preparedRef = useRef<PreparedGlyph[] | null>(null)
  const fieldRef = useRef<GlyphField | null>(null)
  const modeRef = useRef<'plasma' | 'image'>('plasma')
  const [tier, setTier] = useState<CapabilityTier | null>(null)
  const [status, setStatus] = useState<string>('')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const env = probeBrowserEnv()
    const detected = detectCapabilityTier(env)
    setTier(detected)

    canvas.width = COLS * CELL_W
    canvas.height = 1 // resized once rows are known; plasma uses a default aspect first
    const defaultRows = 40
    canvas.height = defaultRows * CELL_H

    fieldRef.current = new GlyphField(COLS, defaultRows)
    let rafId: number

    if (detected !== 'webgl2' && detected !== 'webgpu') {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#111'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#888'
        ctx.font = '12px monospace'
        ctx.fillText('CPU fallback tier — WebGL2/WebGPU unavailable', 12, 24)
      }
      return undefined
    }

    const gl = canvas.getContext('webgl2')
    if (!gl) {
      setTier('cpu')
      return undefined
    }
    const renderer = createInstancedGridRenderer(gl)
    renderer.resize(fieldRef.current.cols, fieldRef.current.rows)
    rendererRef.current = renderer

    const atlas = createGlyphAtlas(gl, getCharset(CHARSET_ID).codepoints, FONT_FAMILY, CELL_W, CELL_H)
    atlasRef.current = atlas
    preparedRef.current = prepareGlyphs(atlas.glyphs)
    renderer.setAtlas(atlas.texture, atlas.glyphs.length)

    const start = performance.now()
    const frame = () => {
      const field = fieldRef.current
      if (!field) return
      if (modeRef.current === 'plasma') {
        paintPlasma(field, (performance.now() - start) / 1000)
      }
      renderer.upload(field)
      renderer.draw(canvas.width, canvas.height)
      rafId = requestAnimationFrame(frame)
    }
    frame()

    return () => {
      cancelAnimationFrame(rafId)
      renderer.dispose()
    }
  }, [])

  function handleFile(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    if (!file) return
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    const prepared = preparedRef.current
    if (!canvas || !renderer || !prepared) return

    setStatus('Converting…')
    const img = new Image()
    img.onload = () => {
      const t0 = performance.now()
      const field = imageToGlyphField(img, prepared)
      const ms = (performance.now() - t0).toFixed(0)
      fieldRef.current = field
      modeRef.current = 'image'
      canvas.width = field.cols * CELL_W
      canvas.height = field.rows * CELL_H
      renderer.resize(field.cols, field.rows)
      renderer.upload(field)
      renderer.draw(canvas.width, canvas.height)
      setStatus(`${field.cols}x${field.rows} glyphs in ${ms}ms`)
      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(file)
  }

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__title">GLYPHFORGE</span>
        <span className="app__tier">tier: {tier ?? 'detecting…'}</span>
        <label className="app__upload">
          Upload image
          <input type="file" accept="image/*" onChange={handleFile} />
        </label>
        {status && <span className="app__status">{status}</span>}
      </header>
      <div className="app__canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
