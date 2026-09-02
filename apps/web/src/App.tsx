import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
} from 'react'
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
  WEIGHTS_PHOTOGRAPHIC,
  WEIGHTS_TECHNICAL,
  WEIGHTS_DRAMATIC,
  WEIGHTS_CLASSIC,
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
import { IconUpload, IconDownload, IconChevronDown } from './icons.js'

const CELL_W = 8
const CELL_H = 14
// Real conversions used to render at a fixed 220 columns regardless of screen size —
// crisp when the display happened to be wide enough, but on anything smaller the
// browser had to shrink the (larger) canvas to fit, which is the exact sub-pixel-glyph
// blur that was fixed earlier. And displaying it at true native size without shrinking
// meant scrolling to see the whole thing, which read as "overlapping the screen".
// Fixing both at once: pick the column count that makes the *native* render exactly
// fill the available space, so there is never any post-hoc scaling in either direction.
// The floor is deliberately low (not the old fixed-resolution target of 140) - on a
// phone-width stage, "fits without scrolling" has to win over "at least 140 columns",
// or every phone conversion would overflow again. 240 is where Node-profiled conversion
// time (denoise blur + DoG/Sobel + per-cell dual-cell/match/edge) starts costing several
// seconds, so that's the ceiling on huge monitors.
const CONVERSION_COLS_MIN = 40
const CONVERSION_COLS_MAX = 240
// The idle plasma demo used to share COLS with real conversions, so its canvas was
// exactly as oversized (1760px+) — no image loaded yet, but already needing scroll.
// Sized from the actual viewport at mount (see fitPlasmaCols below) rather than a
// fixed constant — a hardcoded value tuned against one screen size just overflows
// on a narrower one (phones range ~360-430px; a dev pane isn't representative).
const PLASMA_ASPECT = 22 / 48 // rows per column, matches the demo's original look
const PLASMA_COLS_MIN = 24
// 80 (640px wide) was tuned back when the demo was a small decorative box regardless of
// screen size. Now that it fills the stage like a real conversion does, that cap left a
// large dead void next to it on any laptop/desktop screen wider than ~640px - which is
// most of them. Reuses the same ceiling real conversions use for the same box.
const PLASMA_COLS_MAX = CONVERSION_COLS_MAX
const FONT_FAMILY = 'ui-monospace, "JetBrains Mono", "IBM Plex Mono", monospace'
// ascii-full (95 glyphs) rather than ascii-safe: more shapes to match against, and it
// already contains the four directional glyphs the edge pass overrides onto (- | / \).
const CHARSET_ID = 'ascii-full'

/**
 * Style presets — user-selectable rather than a single hardcoded guess. Applied to the
 * single-tone fallback path (PLAN §4.4 degenerate case; the dual-cell path always
 * matches structure-first since it's matching an actual binary shape, not a photo).
 */
interface StylePreset {
  id: string
  label: string
  weights: MatchWeights
}
const STYLE_PRESETS: StylePreset[] = [
  { id: 'balanced', label: 'Balanced', weights: { wStruct: 0.45, wTone: 1.0, wEdge: 0, wTemp: 0, wPrior: 0 } },
  { id: 'photographic', label: 'Photographic', weights: WEIGHTS_PHOTOGRAPHIC },
  { id: 'technical', label: 'Technical', weights: WEIGHTS_TECHNICAL },
  { id: 'dramatic', label: 'Dramatic', weights: WEIGHTS_DRAMATIC },
  { id: 'classic', label: 'Classic', weights: WEIGHTS_CLASSIC },
]

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

/** Picks a plasma-demo column count that fills (not overflows) the given container width. */
function fitPlasmaCols(containerWidthPx: number): number {
  const cols = Math.floor(containerWidthPx / CELL_W)
  return Math.max(PLASMA_COLS_MIN, Math.min(PLASMA_COLS_MAX, cols))
}

/**
 * Picks the column count that makes a native (1:1, unscaled) render of an image with
 * the given aspect ratio exactly fill the available box — the fix for needing to either
 * blur-shrink a fixed-resolution render to fit, or scroll a full-resolution one to see it.
 */
function fitConversionCols(availW: number, availH: number, imgAspect: number): number {
  const maxColsByWidth = Math.floor(availW / CELL_W)
  const maxColsByHeight = Math.floor(availH / (imgAspect * CELL_W))
  const cols = Math.min(maxColsByWidth, maxColsByHeight)
  return Math.max(CONVERSION_COLS_MIN, Math.min(CONVERSION_COLS_MAX, cols))
}

// Rows budget for exports — same role CONVERSION_COLS_MAX plays for columns (a ceiling
// on conversion time), but exports have no viewport to bound rows against the way the
// live preview does, so a portrait image would otherwise chase CONVERSION_COLS_MAX
// columns into an unbounded (and unboundedly slow) row count.
const EXPORT_ROWS_MAX = 200

/**
 * The on-screen preview is intentionally capped at whatever fits the viewport without
 * scrolling (fitConversionCols) — that's what fixed the earlier "image overlaps the
 * screen" bug. But that same cap means any screen narrower than the full detail budget
 * (basically every screen smaller than ~1920px for a wide image) silently caps fidelity
 * too, which is what "the image looks bad" turned out to be for image-dense sources
 * (many small faces/text at once): the preview was never wrong to fit the screen, but
 * conflating "fits on screen" with "as detailed as the pipeline can produce" cost
 * fidelity on exactly the images most likely to need every column they can get.
 * Downloads aren't shown on screen, so they aren't bound by that constraint — this
 * gives them the full CONVERSION_COLS_MAX ceiling (clamped only by EXPORT_ROWS_MAX for
 * portrait images), independent of whatever the live preview happened to fit.
 */
function computeExportCols(imgAspect: number): number {
  const unboundedWidth = (CONVERSION_COLS_MAX + 1) * CELL_W
  return fitConversionCols(unboundedWidth, EXPORT_ROWS_MAX * CELL_H, imgAspect)
}

// Capped rather than using the full devicePixelRatio: a common phone at 3x DPR would
// otherwise render 9x the pixels of a 1x display for the same visual size (GPU fill-
// rate and memory scale with the square of the ratio). 2x already reads as fully crisp
// at normal viewing distance for text this size — the gap between 2x and 3x is not
// perceptible the way 1x-vs-2x obviously is.
const MAX_DEVICE_PIXEL_RATIO = 2

/**
 * Sets a canvas's backing-store resolution to its CSS display size scaled by the
 * device pixel ratio, while pinning the CSS size to what it would otherwise default
 * to. Without this, the backing store matches the CSS size 1:1 and the browser has to
 * upscale it to fill the screen's actual physical pixels on any high-DPI display —
 * effectively every modern phone — which reintroduces blur through a different
 * mechanism than the fixed-resolution-vs-viewport mismatch fixed earlier: that fix
 * made the *logical* grid fit the *logical* viewport, but said nothing about how many
 * *physical* pixels back each logical one, which is what a phone's 2-3x DPR governs.
 */
function sizeCanvasForDisplay(canvas: HTMLCanvasElement, cssW: number, cssH: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
}

/**
 * The available content box of `.app__stage`, padding excluded. Must be read from the
 * stage element itself, not from `canvas.parentElement` — the canvas's wrapper divs
 * (`.app__canvas-frame`, `.app__stage-content`) are shrink-to-fit flex items with no
 * explicit width, so their clientWidth just reflects the canvas's *current* size, not
 * the space actually available. That was a real, previously-shipped bug: the plasma
 * demo measured its own wrapper and landed near the browser's ~300px canvas default
 * regardless of viewport, rather than the true stage width.
 */
function getStageAvailableSize(stage: HTMLElement): { width: number; height: number } {
  const style = window.getComputedStyle(stage)
  const paddingX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
  const paddingY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0')
  return {
    width: stage.clientWidth - paddingX,
    height: stage.clientHeight - paddingY,
  }
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
  weights: MatchWeights,
  cols: number,
): GlyphField {
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
        // A flat cell's color IS its color — hardcoding bg to black here was discarding
        // it entirely, which is why solid-color regions (flat-design illustrations,
        // logos, large sky/wall areas) rendered mostly black with only faint tinted
        // glyph strokes instead of the actual color. Both fg/bg now anchor to the cell's
        // true average color, with a small symmetric lightness offset so the glyph shape
        // stays visible as a subtle emboss rather than vanishing (fg==bg).
        chIndex = matchGlyphFast(tile, prepared, weights).index
        const avgOklab = linearToOklab({ r: sumR / cellPixels, g: sumG / cellPixels, b: sumB / cellPixels })
        const SHADE = 0.07
        fg = packLinearRgb(oklabToLinear({ L: clamp01(avgOklab.L + SHADE), a: avgOklab.a, b: avgOklab.b }))
        bg = packLinearRgb(oklabToLinear({ L: clamp01(avgOklab.L - SHADE), a: avgOklab.a, b: avgOklab.b }))
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
  const stageRef = useRef<HTMLElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const glowRafRef = useRef<number | null>(null)
  const rendererRef = useRef<InstancedGridRenderer | null>(null)
  const atlasRef = useRef<GlyphAtlas | null>(null)
  const preparedRef = useRef<PreparedGlyph[] | null>(null)
  const directionIndexRef = useRef<Record<Direction, number> | null>(null)
  const fieldRef = useRef<GlyphField | null>(null)
  const modeRef = useRef<'plasma' | 'image'>('plasma')
  const loadedImageRef = useRef<HTMLImageElement | null>(null)
  const [tier, setTier] = useState<CapabilityTier | null>(null)
  const [status, setStatus] = useState<string>('')
  const [hasImage, setHasImage] = useState(false)
  const [presetId, setPresetId] = useState(STYLE_PRESETS[0]!.id)
  const isConverting = status === 'Converting…'
  const [showScrollHint, setShowScrollHint] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  // Tracks drag-over state for the whole stage, not just a sub-region — a converter
  // tool's most natural gesture is "drop the image anywhere on the preview area",
  // not hunting for a specific drop target.
  const [isDragging, setIsDragging] = useState(false)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const env = probeBrowserEnv()
    const detected = detectCapabilityTier(env)
    setTier(detected)

    // Size the demo to the actual available width so it fills without overflowing —
    // a fixed constant tuned against one screen just overflows a narrower one.
    const availableW = stageRef.current ? getStageAvailableSize(stageRef.current).width : 640
    const plasmaCols = fitPlasmaCols(availableW)
    const plasmaRows = Math.max(10, Math.round(plasmaCols * PLASMA_ASPECT))

    sizeCanvasForDisplay(canvas, plasmaCols * CELL_W, plasmaRows * CELL_H)

    fieldRef.current = new GlyphField(plasmaCols, plasmaRows)
    // 0 is never a real requestAnimationFrame id, so cancelAnimationFrame(0) in cleanup
    // is a safe no-op if the static (reduced-motion) path below never assigns a real one.
    let rafId = 0

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
    renderer.setAtlas(atlas.texture, atlas.glyphs.length, atlas.cellW)

    // Respect prefers-reduced-motion: the plasma demo is continuous background motion,
    // a vestibular trigger for some users — freeze it to a single static frame instead.
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const start = performance.now()
    const frame = () => {
      const field = fieldRef.current
      if (!field) return
      if (modeRef.current === 'plasma' && !prefersReducedMotion) {
        paintPlasma(field, (performance.now() - start) / 1000)
        renderer.upload(field)
        renderer.draw(canvas.width, canvas.height)
        rafId = requestAnimationFrame(frame)
        return
      }
      // Static case (reduced motion, or a real image already drawn elsewhere): paint
      // once and stop — looping forever to redraw an unchanged field wastes battery.
      if (modeRef.current === 'plasma') paintPlasma(field, 0)
      renderer.upload(field)
      renderer.draw(canvas.width, canvas.height)
    }
    frame()

    return () => {
      cancelAnimationFrame(rafId)
      renderer.dispose()
    }
  }, [])

  function runConversion(img: HTMLImageElement, weights: MatchWeights): void {
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    const prepared = preparedRef.current
    const directionIndex = directionIndexRef.current
    if (!canvas || !renderer || !prepared || !directionIndex) return

    // Resolve *before* the setTimeout: computed from the stage's current box, so a
    // browser resize between click and conversion doesn't change the target mid-flight.
    const stage = stageRef.current
    const { width: availW, height: availH } = stage ? getStageAvailableSize(stage) : { width: 900, height: 600 }
    const cols = fitConversionCols(availW, availH, img.height / img.width)

    setStatus('Converting…')
    // setTimeout, not requestAnimationFrame: rAF is fully suspended on a backgrounded
    // tab, so if the user switches away while this fires the conversion would simply
    // never run and "Converting…" would hang forever. setTimeout still fires (throttled)
    // in background tabs, while still yielding a paint for the status text first.
    setTimeout(() => {
      const t0 = performance.now()
      const field = imageToGlyphField(img, prepared, directionIndex, weights, cols)
      const ms = (performance.now() - t0).toFixed(0)
      fieldRef.current = field
      modeRef.current = 'image'
      sizeCanvasForDisplay(canvas, field.cols * CELL_W, field.rows * CELL_H)
      renderer.resize(field.cols, field.rows)
      renderer.upload(field)
      // Reveal fade: set transparent, draw, then let the next frame's opacity change
      // animate via the canvas's CSS transition — a plain draw() would just pop the
      // result into view instantly, which reads as a glitch rather than a reveal.
      canvas.style.opacity = '0'
      renderer.draw(canvas.width, canvas.height)
      requestAnimationFrame(() => {
        canvas.style.opacity = '1'
      })
      setStatus(`${field.cols}x${field.rows} glyphs in ${ms}ms`)
      setHasImage(true)

      const stage = stageRef.current
      if (stage) {
        // Compare CSS display size, not the (now DPR-scaled) backing-store size in
        // canvas.width/height — those are no longer the same thing as of
        // sizeCanvasForDisplay above, and comparing the backing store against the
        // stage's CSS-pixel clientWidth would over-report overflow on any high-DPI
        // screen even when the visible size actually fits fine.
        const { width: availW, height: availH } = getStageAvailableSize(stage)
        setShowScrollHint(field.cols * CELL_W > availW || field.rows * CELL_H > availH)
      }
    }, 0)
  }

  function loadImageFile(file: File): void {
    if (!file.type.startsWith('image/')) return
    const img = new Image()
    img.onload = () => {
      loadedImageRef.current = img
      const weights = STYLE_PRESETS.find((p) => p.id === presetId)?.weights ?? STYLE_PRESETS[0]!.weights
      runConversion(img, weights)
      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(file)
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    if (!file) return
    loadImageFile(file)
  }

  // dragenter/dragleave fire on every child boundary crossed, not just the stage's own
  // edge — a naive setIsDragging(false) on dragleave flickers the highlight off while
  // the pointer is still over a child element. Counting enter/leave depth (rather than
  // trusting a single boolean) is the standard fix.
  function handleStageDragEnter(e: ReactDragEvent<HTMLElement>): void {
    e.preventDefault()
    dragDepthRef.current += 1
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }

  function handleStageDragOver(e: ReactDragEvent<HTMLElement>): void {
    // Required even though dragenter already ran — without preventDefault on dragover
    // too, the browser rejects the drop and falls back to navigating to the file.
    e.preventDefault()
  }

  function handleStageDragLeave(e: ReactDragEvent<HTMLElement>): void {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }

  function handleStageDrop(e: ReactDragEvent<HTMLElement>): void {
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadImageFile(file)
  }

  function handleEmptyStageClick(): void {
    // Only the empty (no-image-yet) state doubles as a click target — once a
    // conversion exists, clicking the canvas should not immediately reopen the file
    // picker and discard it.
    if (!hasImage && !isConverting) fileInputRef.current?.click()
  }

  function handlePresetChange(e: ChangeEvent<HTMLSelectElement>): void {
    const id = e.target.value
    setPresetId(id)
    const img = loadedImageRef.current
    if (!img) return
    const weights = STYLE_PRESETS.find((p) => p.id === id)?.weights ?? STYLE_PRESETS[0]!.weights
    runConversion(img, weights)
  }

  function handleStageMouseMove(e: ReactMouseEvent<HTMLElement>): void {
    // rAF-coalesced: mousemove can fire 100+ times/sec, but the glow only needs to
    // update once per rendered frame — coalescing avoids piling up redundant style
    // recalculations behind the (comparatively expensive) blurred-gradient repaint.
    if (glowRafRef.current !== null) return
    const clientX = e.clientX
    const clientY = e.clientY
    glowRafRef.current = requestAnimationFrame(() => {
      glowRafRef.current = null
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const localX = clientX - rect.left
      const localY = clientY - rect.top
      stage.style.setProperty('--mx', `${(localX / rect.width) * 100}%`)
      stage.style.setProperty('--my', `${(localY / rect.height) * 100}%`)
      // Drives the custom cursor-dot's position (see .app__cursor-dot) — kept as raw
      // px, not a percentage, since the dot's own size shouldn't scale with the stage.
      stage.style.setProperty('--cursor-x', `${localX}px`)
      stage.style.setProperty('--cursor-y', `${localY}px`)
    })
  }

  function handleStageScroll(): void {
    if (showScrollHint) setShowScrollHint(false)
  }

  /**
   * Re-runs the matcher at export resolution (see computeExportCols) rather than
   * reusing fieldRef — fieldRef holds whatever the *screen* fit, which on most
   * screens is well under the pipeline's real detail ceiling.
   */
  function buildExportField(): GlyphField | null {
    const img = loadedImageRef.current
    const prepared = preparedRef.current
    const directionIndex = directionIndexRef.current
    if (!img || !prepared || !directionIndex) return null
    const weights = STYLE_PRESETS.find((p) => p.id === presetId)?.weights ?? STYLE_PRESETS[0]!.weights
    const cols = computeExportCols(img.height / img.width)
    return imageToGlyphField(img, prepared, directionIndex, weights, cols)
  }

  function downloadPng(): void {
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!canvas || !renderer || isExporting) return
    setIsExporting(true)
    // setTimeout, not a direct call: yields a paint first so the disabled/busy button
    // state is visible before the (synchronous, potentially ~1s) re-match blocks the
    // main thread — same reasoning as runConversion's use of setTimeout over rAF.
    setTimeout(() => {
      const field = buildExportField()
      const liveField = fieldRef.current
      if (!field || !liveField) {
        setIsExporting(false)
        return
      }
      // Render the export-resolution field into the same canvas/renderer used for the
      // live preview (avoiding a second GL context + glyph atlas for a one-off export),
      // capture it, then restore the on-screen field. Hidden behind opacity 0 for the
      // duration so the resolution swap never paints to the screen.
      const prevW = canvas.width
      const prevH = canvas.height
      const prevCssW = canvas.style.width
      const prevCssH = canvas.style.height
      const prevOpacity = canvas.style.opacity
      canvas.style.opacity = '0'
      sizeCanvasForDisplay(canvas, field.cols * CELL_W, field.rows * CELL_H)
      renderer.resize(field.cols, field.rows)
      renderer.upload(field)
      renderer.draw(canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        canvas.width = prevW
        canvas.height = prevH
        canvas.style.width = prevCssW
        canvas.style.height = prevCssH
        renderer.resize(liveField.cols, liveField.rows)
        renderer.upload(liveField)
        renderer.draw(canvas.width, canvas.height)
        canvas.style.opacity = prevOpacity
        setIsExporting(false)
        if (!blob) return
        const url = URL.createObjectURL(blob)
        triggerDownload(url, 'glyphforge.png')
        URL.revokeObjectURL(url)
      }, 'image/png')
    }, 0)
  }

  function downloadText(): void {
    const atlas = atlasRef.current
    if (!atlas || isExporting) return
    setIsExporting(true)
    setTimeout(() => {
      const field = buildExportField()
      setIsExporting(false)
      if (!field) return
      const codepoints = atlas.glyphs.map((g) => g.codepoint)
      const blob = new Blob([fieldToText(field, codepoints)], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      triggerDownload(url, 'glyphforge.txt')
      URL.revokeObjectURL(url)
    }, 0)
  }

  function downloadAnsi(): void {
    const atlas = atlasRef.current
    if (!atlas || isExporting) return
    setIsExporting(true)
    setTimeout(() => {
      const field = buildExportField()
      setIsExporting(false)
      if (!field) return
      const codepoints = atlas.glyphs.map((g) => g.codepoint)
      const blob = new Blob([fieldToAnsi(field, codepoints)], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      triggerDownload(url, 'glyphforge.ans')
      URL.revokeObjectURL(url)
    }, 0)
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__title">GLYPHFORGE</span>
          <span className="app__tier">{tier ?? 'detecting…'}</span>
        </div>

        <div className="app__toolbar">
          <label className="app__field">
            <span className="app__field-label">Style</span>
            <span className="app__select-wrap">
              <select value={presetId} onChange={handlePresetChange} disabled={!hasImage}>
                {STYLE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <IconChevronDown className="app__select-chevron" />
            </span>
          </label>

          <label className={`app__button app__button--primary${isConverting ? ' app__button--disabled' : ''}`}>
            <IconUpload />
            Upload image
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} disabled={isConverting} />
          </label>

          <div className="app__button-group" role="group" aria-label="Download">
            <button onClick={downloadPng} disabled={!hasImage || isExporting}>
              <IconDownload />
              PNG
            </button>
            <button onClick={downloadText} disabled={!hasImage || isExporting}>
              <IconDownload />
              TXT
            </button>
            <button onClick={downloadAnsi} disabled={!hasImage || isExporting}>
              <IconDownload />
              ANSI
            </button>
          </div>
        </div>

        {(status || isExporting) && (
          <span className={`app__status${isConverting || isExporting ? ' app__status--busy' : ''}`} aria-live="polite">
            {(isConverting || isExporting) && <span className="app__spinner" aria-hidden="true" />}
            {isExporting ? 'Rendering export detail…' : status}
          </span>
        )}
      </header>

      <main
        className={`app__stage${isDragging ? ' app__stage--dragging' : ''}${!hasImage ? ' app__stage--empty' : ''}`}
        ref={stageRef}
        onMouseMove={handleStageMouseMove}
        onScroll={handleStageScroll}
        onDragEnter={handleStageDragEnter}
        onDragOver={handleStageDragOver}
        onDragLeave={handleStageDragLeave}
        onDrop={handleStageDrop}
        onClick={handleEmptyStageClick}
      >
        <div className="app__stage-glow" aria-hidden="true" />
        <div className="app__cursor-dot" aria-hidden="true" />
        <div className="app__stage-content">
          {!hasImage && (
            <div className="app__hero">
              <h1 className="app__hero-title">Turn photos into ASCII art</h1>
              <p className="app__hero-subtitle">
                A perceptual glyph matcher, not a brightness ramp — real structure, real color, real
                detail.
              </p>
              <ul className="app__hero-chips" aria-hidden="true">
                <li>Linear-light color</li>
                <li>Oklab perceptual match</li>
                <li>GPU instanced render</li>
              </ul>
              <p className="app__hero-hint">Drop an image anywhere here, or click to browse</p>
            </div>
          )}
          <div className={`app__canvas-frame${isConverting ? ' app__canvas-frame--busy' : ''}`}>
            <canvas ref={canvasRef} />
            {!hasImage && <span className="app__live-badge">Live preview</span>}
            {isConverting && (
              <div className="app__canvas-busy" aria-hidden="true">
                <span className="app__canvas-busy-ring" />
              </div>
            )}
          </div>
        </div>
        {isDragging && (
          <div className="app__drop-overlay" aria-hidden="true">
            <IconUpload size={28} />
            Drop to convert
          </div>
        )}
        {showScrollHint && (
          <span className="app__scroll-hint">
            <IconChevronDown />
            Scroll to see the full image
          </span>
        )}
      </main>
    </div>
  )
}
