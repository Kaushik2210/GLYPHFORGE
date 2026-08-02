import { useEffect, useRef, useState, type ReactElement, type ChangeEvent } from 'react'
import {
  GlyphField,
  packRgba8,
  srgbToLinear,
  linearToSrgb,
  linearToOklab,
  oklabToLinear,
  solveDualCell,
  dualCellMaskAsTile,
  gaussianBlur,
  differenceOfGaussians,
  sobel,
  computeCellEdge,
  classifyDirection,
  matchGlyphFast,
  prepareGlyphs,
  fieldToText,
  fieldToAnsi,
  getCharset,
  type MatchWeights,
  type PreparedGlyph,
  type Oklab,
  type LumaField,
  type Direction,
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
// ascii-full (95 glyphs) rather than ascii-safe: more shapes to match against, and it
// already contains the four directional glyphs the edge pass overrides onto (- | / \).
const CHARSET_ID = 'ascii-full'

/**
 * Balanced for photographic clarity: tone dominant (so brightness reads correctly),
 * structure meaningful but not overriding (kicks in on real edges/texture — flat
 * regions no longer engage it at all, see tileConfidence in packages/core/match/cost.ts).
 * Used as the fallback path when a cell's dual-cell separation is too low (PLAN §4.4
 * degenerate case).
 */
const IMAGE_WEIGHTS: MatchWeights = { wStruct: 0.7, wTone: 1.0, wEdge: 0, wTemp: 0, wPrior: 0 }

/** The dual-cell mask is a clean binary shape (PLAN §4.4) — match it structure-first. */
const DUAL_CELL_WEIGHTS: MatchWeights = { wStruct: 1.0, wTone: 0.3, wEdge: 0, wTemp: 0, wPrior: 0 }

/** Oklab distance between a cell's two color clusters. Below this the cell reads as one
 * flat color (PLAN §4.4 degenerate case) and falls back to single-tone matching.
 * 2-means always finds *some* split, even in a perfectly smooth gradient — measured
 * separation for a gentle photographic gradient runs ~0.01-0.03, a steep one ~0.07-0.15,
 * and a real hard edge ~0.15-0.5+. Too low a threshold (0.06 originally) treats smooth
 * gradient/sensor-noise cells as hard edges, rendering them as speckled noise instead of
 * a clean tone falloff — this is what "the image quality is bad" turned out to be. */
const DUAL_CELL_SEPARATION_THRESHOLD = 0.18

/** Gaussian sigma (in source pixels) for the DoG edge pass — PLAN §5.1. */
const EDGE_SIGMA = 1.0
/** Mean Sobel magnitude per cell above which an edge override is even considered. */
const EDGE_MAGNITUDE_THRESHOLD = 0.8
/** Structure-tensor coherence above which an edge is "clean" (one orientation) rather
 * than noisy texture — PLAN §5.1's fix for "scratchy" random-slash regions. */
const EDGE_COHERENCE_THRESHOLD = 0.5

const DIRECTION_CODEPOINTS: Record<Direction, number> = { '-': 0x2d, '|': 0x7c, '/': 0x2f, '\\': 0x5c }

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

function packLinearRgb(lin: { r: number; g: number; b: number }): number {
  const r = Math.round(linearToSrgb(clamp01(lin.r)) * 255)
  const g = Math.round(linearToSrgb(clamp01(lin.g)) * 255)
  const b = Math.round(linearToSrgb(clamp01(lin.b)) * 255)
  return packRgba8(r, g, b)
}

function buildDirectionIndex(atlas: GlyphAtlas): Record<Direction, number> {
  const map = {} as Record<Direction, number>
  for (const dir of ['-', '|', '/', '\\'] as Direction[]) {
    const codepoint = DIRECTION_CODEPOINTS[dir]
    const found = atlas.glyphs.find((g) => g.codepoint === codepoint)
    map[dir] = found ? found.index : 0
  }
  return map
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Converts a loaded image into a GlyphField using the full matcher: per-cell dual-color
 * solve (PLAN §4.4, falling back to single-tone on flat cells), the DoG/Sobel/structure-
 * tensor edge pass (§5.1, overriding onto a directional glyph on clean coherent edges),
 * and auto-contrast so limited-range photos still spread across the charset. Per
 * invariant #10, the source is sampled at exactly cell-bitmap resolution.
 */
function imageToGlyphField(
  img: HTMLImageElement,
  prepared: readonly PreparedGlyph[],
  directionIndex: Record<Direction, number>,
): GlyphField {
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
  const pixelCount = srcW * srcH

  // Denoise before matching: browsers dither gradients (ordered dither, not random) to
  // avoid banding, and real photos carry sensor/JPEG noise. Left alone, that noise has
  // enough local contrast to look like "structure" to the matcher — a smooth sky renders
  // as a repeating moiré of unrelated glyphs instead of a clean tone falloff. A small
  // blur kills it while leaving real edges (which have energy at a much larger scale)
  // intact. Spatial analogue of the temporal-noise-filtering technique in PLAN §9.2.
  const rRaw = new Float32Array(pixelCount)
  const gRaw = new Float32Array(pixelCount)
  const bRaw = new Float32Array(pixelCount)
  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 4
    rRaw[p] = srgbToLinear((rgba[idx] ?? 0) / 255)
    gRaw[p] = srgbToLinear((rgba[idx + 1] ?? 0) / 255)
    bRaw[p] = srgbToLinear((rgba[idx + 2] ?? 0) / 255)
  }
  // Wide enough to average out an 8x8 ordered-dither (Bayer) tile — browsers commonly
  // use that block size for gradient dithering, which happens to match CELL_W and was
  // aliasing into a period-8 repeating pattern per cell before this was widened.
  const DENOISE_SIGMA = 2.5
  const rBuf = gaussianBlur({ width: srcW, height: srcH, data: rRaw }, DENOISE_SIGMA).data
  const gBuf = gaussianBlur({ width: srcW, height: srcH, data: gRaw }, DENOISE_SIGMA).data
  const bBuf = gaussianBlur({ width: srcW, height: srcH, data: bRaw }, DENOISE_SIGMA).data

  // Auto-contrast: most photos don't use the full [0,1] luminance range, which collapses
  // many cells onto near-identical glyphs. Stretch luminance to full range before it drives
  // glyph selection — displayed color (fg, below) stays true to the source.
  let lumaMin = Infinity
  let lumaMax = -Infinity
  const lumaBuf = new Float32Array(pixelCount)
  for (let p = 0; p < pixelCount; p++) {
    const luma = linearLuma(rBuf[p] ?? 0, gBuf[p] ?? 0, bBuf[p] ?? 0)
    lumaBuf[p] = luma
    if (luma < lumaMin) lumaMin = luma
    if (luma > lumaMax) lumaMax = luma
  }
  const lumaRange = Math.max(lumaMax - lumaMin, 1e-4)
  for (let p = 0; p < pixelCount; p++) {
    lumaBuf[p] = clamp01(((lumaBuf[p] ?? 0) - lumaMin) / lumaRange)
  }

  // Edge pass: DoG on the (contrast-stretched) luminance field, then Sobel, then a
  // per-cell structure tensor tells us whether there's one clean orientation to draw.
  const lumaField: LumaField = { width: srcW, height: srcH, data: lumaBuf }
  const dog = differenceOfGaussians(lumaField, EDGE_SIGMA)
  const grad = sobel(dog)

  const field = new GlyphField(cols, rows)
  const tile = new Float32Array(CELL_W * CELL_H)
  const cellPixels = CELL_W * CELL_H
  // Reused across cells to avoid allocating ~cellPixels objects per cell (GC pressure).
  const pixelPool: Oklab[] = Array.from({ length: cellPixels }, () => ({ L: 0, a: 0, b: 0 }))

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
          const r = rBuf[p] ?? 0
          const g = gBuf[p] ?? 0
          const b = bBuf[p] ?? 0
          sumR += r
          sumG += g
          sumB += b
          tile[t] = lumaBuf[p] ?? 0
          const oklab = linearToOklab({ r, g, b })
          const slot = pixelPool[t]!
          slot.L = oklab.L
          slot.a = oklab.a
          slot.b = oklab.b
          t++
        }
      }

      const dual = solveDualCell(pixelPool)
      let chIndex: number
      let fg: number
      let bg: number

      if (dual.separation > DUAL_CELL_SEPARATION_THRESHOLD) {
        const maskTile = dualCellMaskAsTile(dual.mask)
        chIndex = matchGlyphFast(maskTile, prepared, DUAL_CELL_WEIGHTS).index
        fg = packLinearRgb(oklabToLinear(dual.c1))
        bg = packLinearRgb(oklabToLinear(dual.c0))
      } else {
        chIndex = matchGlyphFast(tile, prepared, IMAGE_WEIGHTS).index
        fg = packLinearRgb({ r: sumR / cellPixels, g: sumG / cellPixels, b: sumB / cellPixels })
        bg = packRgba8(0, 0, 0)
      }

      const cellEdge = computeCellEdge(grad, cx, cy, CELL_W, CELL_H)
      if (cellEdge.magnitude > EDGE_MAGNITUDE_THRESHOLD && cellEdge.coherence > EDGE_COHERENCE_THRESHOLD) {
        chIndex = directionIndex[classifyDirection(cellEdge.angle)]
      }

      field.set(cx, cy, { ch: chIndex, fg, bg })
    }
  }
  return field
}

export function App(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<InstancedGridRenderer | null>(null)
  const atlasRef = useRef<GlyphAtlas | null>(null)
  const preparedRef = useRef<PreparedGlyph[] | null>(null)
  const directionIndexRef = useRef<Record<Direction, number> | null>(null)
  const fieldRef = useRef<GlyphField | null>(null)
  const modeRef = useRef<'plasma' | 'image'>('plasma')
  const [tier, setTier] = useState<CapabilityTier | null>(null)
  const [status, setStatus] = useState<string>('')
  const [hasImage, setHasImage] = useState(false)

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

    // preserveDrawingBuffer: without it the browser may clear the drawing buffer after
    // compositing, so canvas.toBlob() (PNG download, arbitrarily long after the last draw)
    // can read back a blank frame. Cheap for a canvas this size.
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
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
    directionIndexRef.current = buildDirectionIndex(atlas)
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
    const directionIndex = directionIndexRef.current
    if (!canvas || !renderer || !prepared || !directionIndex) return

    setStatus('Converting…')
    const img = new Image()
    img.onload = () => {
      const t0 = performance.now()
      const field = imageToGlyphField(img, prepared, directionIndex)
      const ms = (performance.now() - t0).toFixed(0)
      fieldRef.current = field
      modeRef.current = 'image'
      canvas.width = field.cols * CELL_W
      canvas.height = field.rows * CELL_H
      renderer.resize(field.cols, field.rows)
      renderer.upload(field)
      renderer.draw(canvas.width, canvas.height)
      setStatus(`${field.cols}x${field.rows} glyphs in ${ms}ms`)
      setHasImage(true)
      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(file)
  }

  function downloadPng(): void {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      triggerDownload(url, 'glyphforge.png')
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  function downloadText(): void {
    const field = fieldRef.current
    const atlas = atlasRef.current
    if (!field || !atlas) return
    const codepoints = atlas.glyphs.map((g) => g.codepoint)
    const blob = new Blob([fieldToText(field, codepoints)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    triggerDownload(url, 'glyphforge.txt')
    URL.revokeObjectURL(url)
  }

  function downloadAnsi(): void {
    const field = fieldRef.current
    const atlas = atlasRef.current
    if (!field || !atlas) return
    const codepoints = atlas.glyphs.map((g) => g.codepoint)
    const blob = new Blob([fieldToAnsi(field, codepoints)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    triggerDownload(url, 'glyphforge.ans')
    URL.revokeObjectURL(url)
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
        {hasImage && (
          <div className="app__downloads">
            <button onClick={downloadPng}>PNG</button>
            <button onClick={downloadText}>TXT</button>
            <button onClick={downloadAnsi}>ANSI</button>
          </div>
        )}
        {status && <span className="app__status">{status}</span>}
      </header>
      <div className="app__canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
