# GLYPHFORGE — Build Plan
**A GPU-native ASCII motion engine.** Photoreal image/video → glyphs, a shader-grade effects stack, a real 3D renderer, physics sims, and an AI layer — all in the browser.
> Positioning vs. ASCII Motion: ASCII Motion is a *drawing tool that can convert media*. GLYPHFORGE is a *rendering engine that happens to have a drawing tool*. The difference is the pipeline: everything lives in continuous float fields on the GPU until a single, very smart quantization step turns it into characters. That one architectural decision is why this can look dramatically better.
---
## 0. The Thesis
Almost every ASCII converter ever written does this:

```
luminance = 0.299R + 0.587G + 0.114B
char = ramp[floor(luminance * ramp.length)]   //  " .:-=+*#%@"
```

This is why ASCII art looks like mush. It throws away **structure**, **orientation**, **sub-cell detail**, and **temporal continuity** — four of the five things that make an image legible.
GLYPHFORGE's core claim: a text cell is not a pixel. It is a **7×14 (or whatever) binary image patch with ~200 available values**. Choosing the right one is a *nearest-neighbour search in a perceptual feature space*, not an array index. Do that correctly and ASCII stops looking like ASCII art and starts looking like a photograph rendered in a weird font.
Five pillars:
| Pillar | What it buys you |
|---|---|
| **Perceptual glyph matching** | Sub-cell detail. Eyes, text, textures survive. |
| **Edge / structure pass** | Crisp outlines instead of gray fog. |
| **Dual-color cell solve** | 2 colors per cell instead of 1 → effectively doubles resolution. |
| **Temporal coherence** | Video stops shimmering. This is what makes it feel *produced*. |
| **Continuous-domain FX** | Effects composite as floats, quantize once. No compounding error. |
And one thing nobody else has: **a fidelity metric in CI.** See §9.
---
## 1. Stack

```
Vite 6 + React 19 + TypeScript 5.7 (strict)
WebGPU (primary)  →  WebGL2 (degraded fallback)  →  CPU worker (last resort)
WGSL compute shaders for: matching, edges, sims, flow
Zustand + Immer          state + undo/redo
Tailwind 4 + shadcn/ui   interface
WebCodecs                video decode/encode (VideoDecoder / VideoEncoder)
mp4-muxer / webm-muxer   container writing
OPFS                     project + media storage
Comlink                  worker RPC
transformers.js (ONNX/WebGPU)  depth + segmentation models
Vitest + Playwright      unit + visual regression
```

**Hard rules:**
- WebGPU is broadly shipping as of 2026 (Chrome/Edge, Safari 26+, Firefox 147+, Samsung Internet 24+). Build WebGPU-first, feature-detect, degrade gracefully. Do **not** write two full renderers — write one abstraction with two backends and let the WebGL2 path drop the compute-heavy features (3D, fluid sim, optical flow).
- **Never** render the grid with DOM nodes or `fillText` per cell. One instanced draw call, glyph atlas texture, per-instance `{charIndex, fg, bg}`. 200×80 grid = 16,000 instances = free.
- All image math in **linear light**. sRGB→linear on ingest, linear→sRGB on display. Getting this wrong makes everything look washed out and no amount of clever matching will save it.
- Perceptual color operations (quantization, dithering, palette clustering) happen in **Oklab**, not RGB.
---
## 2. Architecture
### 2.1 The two domains
This is the most important idea in the codebase.

```
┌─────────────────────────────────────────────────────────┐
│  CONTINUOUS DOMAIN  (float32 textures, GPU-resident)    │
│                                                          │
│   Sources         Fields              Effects            │
│   ───────         ──────              ───────            │
│   Image      →   luma    (r32f)   →   plasma             │
│   Video      →   color   (rgba16f)→   flow field         │
│   3D scene   →   normal  (rgba16f)→   fluid / fire       │
│   Sim        →   depth   (r32f)   →   glitch / CRT       │
│   Procedural →   velocity(rg16f)  →   bloom / feedback   │
│                  edges   (rg16f)      warp / ripple      │
└──────────────────────────┬──────────────────────────────┘
                           │
                    ╔══════▼══════╗
                    ║  GLYPHIFY   ║   ← the only quantization
                    ║  (compute)  ║      in the whole pipeline
                    ╚══════┬══════╝
                           │
┌──────────────────────────▼──────────────────────────────┐
│  DISCRETE DOMAIN  (GlyphField — SoA typed arrays)       │
│                                                          │
│   ch: Uint16Array    fg: Uint32Array                     │
│   bg: Uint32Array    flags: Uint8Array                   │
│                                                          │
│   Hand-drawn layers · text tool · ANSI import            │
│   composite here, above/below the glyphified result      │
└──────────────────────────┬──────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │   RENDERER  │  instanced quads + atlas
                    │   EXPORTERS │  txt/ansi/svg/json/gif/mp4/webm/rs/c
                    └─────────────┘
```

Effects that operate on **fields** are cheap, composable, and never lose information. Effects that operate on **glyphs** (scramble, wipe, typewriter, char-swap) are a separate, smaller category applied post-glyphify.
### 2.2 Repo layout

```
glyphforge/
├── CLAUDE.md                     ← persistent agent context (shipped separately)
├── PLAN.md                       ← this file
├── packages/
│   ├── core/                     ← zero-DOM, zero-React. Testable in node.
│   │   ├── glyph/
│   │   │   ├── atlas.ts          glyph rasterization + packing
│   │   │   ├── features.ts       per-glyph feature extraction
│   │   │   ├── charsets.ts       curated character sets
│   │   │   └── metrics.ts        cell aspect, font metrics probing
│   │   ├── match/
│   │   │   ├── cpu.ts            reference implementation (slow, correct)
│   │   │   ├── cost.ts           the cost function — THE file
│   │   │   └── temporal.ts       hysteresis + flow-advected prior
│   │   ├── color/
│   │   │   ├── oklab.ts
│   │   │   ├── quantize.ts       median-cut, k-means, wu
│   │   │   ├── dither.ts         FS, Atkinson, Bayer, blue-noise
│   │   │   └── dualcell.ts       2-means fg/bg cell solve
│   │   ├── field/                GlyphField, FieldStack, delta encoding
│   │   ├── graph/                effect DAG: nodes, eval, topo sort, cache
│   │   ├── doc/                  Document, Layer, Frame, Timeline, undo
│   │   └── io/                   .gfx project format, ANSI/txt import
│   ├── gpu/                      ← WebGPU backend
│   │   ├── device.ts             adapter, limits, capability tiers
│   │   ├── passes/
│   │   │   ├── ingest.wgsl       sRGB→linear, resize, tile reduce
│   │   │   ├── dog.wgsl          difference of gaussians
│   │   │   ├── sobel.wgsl        gradient magnitude + angle
│   │   │   ├── structure.wgsl    structure tensor / coherence
│   │   │   ├── match.wgsl        ← the matcher. argmin over glyph atlas
│   │   │   ├── temporal.wgsl     hysteresis + advection
│   │   │   ├── flow.wgsl         Lucas–Kanade pyramidal optical flow
│   │   │   └── fx/*.wgsl         one file per effect
│   │   ├── raster/               3D: gbuffer, shade, shadow, ssao
│   │   └── render/               instanced glyph grid draw
│   ├── sim/                      physics: fluid, particles, boids, RD, cloth
│   ├── media/                    WebCodecs decode/encode, muxing, frame pump
│   ├── ai/                       depth, segmentation, scene-graph DSL
│   └── ui/                       ← React. Thin. Owns nothing but pixels+events.
│       ├── canvas/               viewport, overlays, selection, cursor
│       ├── timeline/             frames, tracks, onion skin, keyframes
│       ├── inspector/            node graph editor, param panels
│       ├── tools/                brush, shape, text, gradient, bezier, fill
│       └── export/               dialogs, progress, presets
├── apps/web/                     Vite entry, routing, persistence, shell
├── bench/                        perf + fidelity harness (runs in CI)
└── fixtures/                     golden images, test video, reference outputs
```

**Boundary discipline:** `core` never imports from `gpu` or `ui`. `gpu` never imports from `ui`. Every GPU pass has a CPU reference implementation in `core` used as the correctness oracle in tests. This is non-negotiable — it's how you debug a shader that produces garbage.
---
## 3. Phase 1 — Glyph Atlas & Renderer
*The floor. Nothing else works without this.*
### 3.1 Atlas generation
Rasterize every candidate glyph offscreen at **4× cell resolution** (supersampled), then box-downsample to cell resolution with a gamma-correct filter. Supersampling matters: glyph edges are where all the detail lives.

```ts
interface GlyphAtlas {
  texture: GPUTexture      // R8, packed grid of glyph bitmaps
  cellW: number            // e.g. 8
  cellH: number            // e.g. 16
  count: number
  codepoints: number[]
  features: Float32Array   // count × FEATURE_DIM, GPU storage buffer
}
```

**Font metric probing:** measure the actual advance width and line height of the chosen monospace font via `TextMetrics`. Cell aspect ratio (typically 0.5–0.6) must be exact or every conversion is subtly stretched. Probe it, don't assume it.
**Curated charsets** (ship these, allow custom):
- `ascii-full` — printable ASCII, 95 glyphs
- `ascii-safe` — no glyphs that break in narrow fonts
- `blocks` — `▀▄█▌▐░▒▓` + quadrants `▘▝▖▗▚▞` (best raw fidelity, 4× effective resolution)
- `sextants` — Unicode 13 sextant blocks `🬀`–`🬿` (6× effective resolution — this is the fidelity cheat code)
- `braille` — `⠀`–`⣿`, 2×4 dots per cell = **8× effective resolution**, best for line art
- `box-drawing` — `─│┌┐└┘├┤┬┴┼╔╗╬` etc., for structure
- `directional` — `|/-\_╱╲` for the edge pass
- `shade` — `░▒▓█` classic ramp
- `katakana` — Matrix mode
- `emoji-mono` — because someone will ask
> **Braille + sextants are the single highest-fidelity trick available.** A braille cell encodes 8 independent binary subpixels. At 200×80 cells that's a 400×320 effective bitmap. Ship a "Braille HD" preset and it will be the demo everyone screenshots.
### 3.2 Feature extraction (per glyph, precomputed once)
For each glyph bitmap `G` (cellW × cellH, values 0–1):

```
coverage     = mean(G)                              // 1 scalar
centroid     = Σ(x,y)·G / Σ G                       // 2 scalars
moments      = μ20, μ11, μ02 (normalized central)   // 3 scalars
gradientHist = 8-bin orientation histogram of ∇G    // 8 scalars
downsample   = G box-filtered to 4×8                // 32 scalars
zernike      = optional, rotation-invariant         // 0 or 8
                                                    ─────────
                                           FEATURE_DIM = 46
```

Store as a `Float32Array` storage buffer. 200 glyphs × 46 floats = 37KB. Nothing.
### 3.3 Renderer
Single instanced draw. Per-instance attributes: `cellIndex (u32)`, `charIndex (u16)`, `fg (u32 rgba8)`, `bg (u32 rgba8)`. Vertex shader computes cell position from index; fragment shader samples the atlas and mixes fg/bg. One draw call, 16k instances, ~0.1ms.
**Acceptance:** render a 240×135 grid of random glyphs at 144fps with zero GC pressure. Resize the grid without reallocating buffers unless capacity is exceeded.
---
## 4. Phase 2 — The Matcher *(the accuracy core)*
This is the phase that determines whether the project is impressive or forgettable. Budget real time here.
### 4.1 The cost function
For image tile `T` (same dims as a cell, in linear luminance) and candidate glyph `g`:

```
cost(T, g) =  w_struct · D_struct(T, g)      // shape mismatch
            + w_tone   · D_tone(T, g)        // brightness mismatch
            + w_edge   · D_edge(T, g)        // orientation mismatch
            + w_temp   · [g ≠ prevGlyph]     // temporal hysteresis
            + w_prior  · penalty(g)          // charset preference / rarity
```

Where:
**`D_struct`** — normalized cross-correlation on the mean-subtracted downsampled patches. This is the workhorse:

```
D_struct = 1 - ⟨T̂, ĝ⟩ / (‖T̂‖·‖ĝ‖ + ε)     where x̂ = x - mean(x)
```

Mean-subtraction is critical: it decouples *shape* from *brightness*, so a `/` matches a diagonal edge regardless of contrast.
**`D_tone`** — `|mean(T) − coverage(g)|`, but with a **coverage-to-luminance transfer curve**. A glyph's ink coverage is not its apparent brightness; anti-aliasing and font hinting make `.` read darker than its 4% coverage suggests. Calibrate this empirically: render each glyph, measure its actual mean luminance as displayed, build a LUT. **Do this. It's a 20-line function that visibly improves output.**
**`D_edge`** — earth-mover distance between the tile's gradient orientation histogram and the glyph's. Cheap approximation: circular L1 on 8 bins.
**Weights are a preset.** Ship named profiles:
- `Photographic` — tone-heavy, structure-medium (portraits, landscapes)
- `Technical` — structure-heavy, edge-heavy (diagrams, screenshots, text)
- `Dramatic` — edge-dominant, high contrast (silhouettes, posters)
- `Classic` — tone-only (the naive look, for nostalgia)
### 4.2 GPU implementation

```wgsl
// match.wgsl — one workgroup per tile of cells
@group(0) @binding(0) var srcLuma:     texture_2d<f32>;
@group(0) @binding(1) var<storage,read> glyphFeat: array<f32>;  // N × 46
@group(0) @binding(2) var<storage,read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> params: MatchParams;
// Strategy: workgroup of 64 threads. Each thread evaluates a stripe of
// candidate glyphs for one cell, cooperative argmin-reduce in workgroup memory.
// Tile features computed once into shared memory before the search.
```

With N=95 glyphs and 16k cells: 1.5M cost evaluations per frame, each ~50 FLOPs. ~75 MFLOP/frame → utterly trivial. Even N=256 with braille runs at 500+ fps. **Do not prematurely optimize this into a k-d tree or PCA projection.** Brute force is correct, simple, and fast enough. Optimize only if the bench says so.
### 4.3 Sub-cell supersampling
Sample the source at **2× or 4× cell resolution** so the tile passed to the matcher has real detail. Rendering a 1920×1080 video into a 240×135 grid means each cell covers 8×8 source pixels — but a cell bitmap is 8×16. Sample at cell-bitmap resolution or higher, always. Mismatched sampling is the #1 source of "why does this look bad."
### 4.4 Dual-color cell solve
For each cell, run **2-means on the tile's pixels in Oklab** → two cluster centers `c0, c1` and a binary assignment mask `M`. Then:
1. Match `M` (a binary pattern!) against glyph bitmaps using `D_struct` — this is a *pure shape match*, extremely accurate.
2. Emit `{char: bestGlyph, fg: c1, bg: c0}`.
This is how good terminal image viewers (chafa, viu) get their quality, and it composes beautifully with everything above. A cell can now represent a hard color boundary at an arbitrary angle. **Effective resolution roughly doubles.** Make it a toggle: `Color mode: Mono | Single | Dual (recommended)`.
Degenerate case: if cluster separation in Oklab is below a threshold, the cell is flat — fall back to the tone/structure matcher with `fg == bg` variance handling.
**Acceptance for Phase 2:** feed in a 1024×1024 portrait, output at 200×100. A person should be identifiable. Measure with the fidelity metric (§9) — target SSIM ≥ 0.72 on the standard test set with `blocks` charset, ≥ 0.55 with `ascii-full`.
---
## 5. Phase 3 — Structure & Color
### 5.1 Edge pass (Acerola-style, extended)

```
1. Luminance → Gaussian blur σ₁ (≈1.0) and σ₂ (≈1.6·σ₁)
2. DoG = G(σ₁) − τ·G(σ₂)                  τ ≈ 0.98
3. Threshold with soft tanh falloff → edge mask E
4. Sobel on E → magnitude |∇| and angle θ
5. Per cell: histogram θ over the tile, weighted by |∇|
6. Coherence c = (λ₁−λ₂)/(λ₁+λ₂) from the structure tensor
7. If  meanMag > t_mag  AND  c > t_coh:
       override glyph with directional glyph for dominant θ
       quantized to {—, |, /, \} (4-way) or 8-way with box-drawing
```

The **structure tensor coherence** term is the upgrade over the standard technique: it distinguishes "this cell has a clean edge with one orientation" from "this cell is noisy texture." Without it, noisy regions fill with random slashes and the whole image looks scratchy. With it, edges appear exactly where a human would draw them.
**Extended-Difference-of-Gaussians (XDoG)** with the sharpening parameter φ gives you an artist-grade line-drawing look for free. Expose φ and τ as sliders — they're the single most visually satisfying parameters in the whole app.
**Line continuation pass:** after edge glyph assignment, run a small 3×3 pass that checks whether a cell's chosen direction is consistent with its neighbours; snap near-misses to form continuous lines. Corner detection → emit `┐┘└┌` from box-drawing set. This is what turns "scattered slashes" into "actual line art."
### 5.2 Color pipeline

```
sRGB → linear → [effects operate here] → Oklab → quantize → dither → sRGB out
```

**Quantization modes:**
- `True color` — 24-bit, no quantization (ANSI 24-bit / SVG / HTML export)
- `256` — xterm-256 palette, nearest in Oklab
- `16` — ANSI 16, nearest in Oklab with intensity bit
- `Custom N` — k-means / Wu quantization in Oklab, N = 2–64
- `Named palettes` — Gameboy DMG, CGA, EGA, C64, PICO-8, Solarized, Nord, Dracula, Tokyo Night, Catppuccin, Sweetie-16, Endesga-32
**Dithering:**
- `None`
- `Ordered / Bayer` 2×2, 4×4, 8×8 — GPU-friendly, temporally stable (**default for video**)
- `Blue noise` — precomputed 64×64 tile, best-looking ordered dither
- `Floyd–Steinberg`, `Atkinson`, `Sierra`, `Jarvis` — serial, CPU worker, for stills only
- `Riemersma` — Hilbert-curve error diffusion, no directional artifacts
⚠️ **Error-diffusion dithers are temporally unstable.** Frame N+1 with a one-pixel shift produces a completely different error field → violent flicker. For video, default to blue noise or Bayer with a **temporally-rotated** offset (golden-ratio sequence per frame), which averages to a cleaner image over time rather than flickering.
Dither *before* glyph matching (on the luminance field) or *after* (on the color)? **Both, separately toggleable.** Dithering the luminance pre-match creates texture that the matcher turns into intricate character patterns — this is a genuinely novel look and you should make it a preset called "Texture."
---
## 6. Phase 4 — Editor, Timeline, Layers
### 6.1 Document model

```ts
Document {
  cols, rows, fps, duration
  charset: CharsetRef
  palette: Palette
  layers: Layer[]           // ordered, bottom→top
  timeline: Timeline
  graph: EffectGraph        // per-layer or global
}
Layer =
  | { kind: 'raster',    frames: GlyphField[] }        // hand-drawn
  | { kind: 'source',    media: MediaRef, transform }  // image/video
  | { kind: 'generator', node: GraphNodeId }           // procedural
  | { kind: 'scene3d',   scene: SceneRef, camera }     // 3D
  | { kind: 'sim',       sim: SimRef, seed }           // physics
Frame storage: keyframe + RLE deltas. A 500-frame 240×135 animation
in naive storage is 500 × 32400 × 8B = 130MB. With deltas + RLE, ~2-8MB.
```

**Undo/redo:** command pattern over the document, not snapshot diffing. Every mutation is a `Command {do, undo, coalesceKey}`. Brush strokes coalesce by `coalesceKey` so a drag is one undo step. Cap history at 200 entries or 256MB, whichever first.
### 6.2 Tools
Brush (with glyph-brush *stamps* — multi-cell patterns), eraser, line, rect, ellipse, **bezier** (with glyph-aware stroking), polygon, flood fill, gradient fill (linear/radial/angular/noise, with dithered glyph ramp), text tool (with figlet-style banner fonts), rectangular + lasso + magic-wand select, transform (move/scale/rotate with re-glyphify option), eyedropper, **glyph-swap** (replace all instances of char X with Y).
**Onion skinning** — configurable N before/after, tinted, opacity ramp.
### 6.3 Timeline
Frames, tracks per layer, **keyframes on any effect parameter** with easing curves (linear, cubic, elastic, bounce, custom bezier, **stepped** — stepped is essential for ASCII since it's inherently quantized). Loop regions, frame tags, per-frame duration override, playback scrubbing at 60fps.
---
## 7. Phase 5 — The Effects Graph
### 7.1 Node graph
A DAG evaluated per frame. Node types:
**Sources:** Image, Video, Solid, Noise (perlin/simplex/worley/curl/value), Gradient, Text, Scene3D, Sim, Time, Audio (FFT bands — yes, audio-reactive ASCII), Webcam.
**Field ops:** Blur, Sharpen, DoG, Sobel, Threshold, Levels, Curves, Warp (by vector field), Displace, Polar, Kaleidoscope, Mirror, Tile, Transform, Feedback (previous frame in), Blend (20 modes), Math (add/mul/mix/pow/step/smoothstep), Remap, Voronoi, Marching Squares, Distance Field, Flow Map.
**Simulation:** see §8.2.
**Stylize:** Bloom, ChromaticAberration, CRT (scanline + curvature + phosphor mask + rolling bar), VHS (tracking noise + chroma bleed + head switch), Glitch (block displace + channel shift + datamosh), Halftone, Posterize, Edge Glow, Scanline Jitter, Interlace.
**Glyphify:** the quantizer. Params: charset, weights preset, color mode, dither, temporal strength.
**Glyph ops (post-quantize):** Scramble, Typewriter reveal, Wipe (linear/radial/random/noise-ordered), Char Cycle, Shift/Scroll, Marquee, Sort (by luminance — "pixel sort" but for glyphs), Replace, Mask.
**Output:** Composite, Layer Out.
### 7.2 The FX library — build these, in this order
Ranked by *impressiveness per hour of work*:
| # | Effect | Technique | Why it's a banger |
|---|---|---|---|
| 1 | **Matrix rain** | Per-column head position + trail decay + katakana charset | It's the ASCII effect. Ship it perfect: variable speed columns, glow head, random glyph mutation in the trail, depth layers. |
| 2 | **Doom fire** | Classic per-pixel upward propagation with random decay, but in a float field with advection | 40 lines. Looks incredible. Add wind via a vector field input. |
| 3 | **Plasma** | Sum of sine fields, time-animated | Demoscene nostalgia, 15 lines. |
| 4 | **Flow field** | Curl noise → particle advection → density accumulation | The prettiest generic generator. Feeds particles into the fluid solver later. |
| 5 | **Ripple / wave** | 2D wave equation, explicit integration, damping | Click-to-drop interaction is irresistible. |
| 6 | **Reaction–diffusion** | Gray–Scott, 2 species, F/k parameter space | Organic, alien, mesmerizing. Ship a parameter-space map so users can explore. |
| 7 | **Stable fluids** | Jos Stam: advect → diffuse → project (Jacobi pressure solve) | The showpiece. Mouse-drag injects velocity + dye. |
| 8 | **Boids** | Separation/alignment/cohesion, spatial hash | Flocking glyphs. Add predator/prey. |
| 9 | **Feedback / trails** | Previous output → transform → blend into current | Infinite tunnel effects for ~10 lines. |
| 10 | **Datamosh glitch** | Block-copy motion vectors from a *different* frame | The most "how did you do that" effect on the list. |
| 11 | **Glyph sort** | Sort cells within row/column spans by luminance, threshold-gated | Pixel sorting, but the glyphs make it uncanny. |
| 12 | **Depth parallax** | Depth map → per-layer offset by mouse/time | See §10 — turns any photo into a 2.5D animation. |
| 13 | **Kaleidoscope** | Polar fold with N-fold symmetry | Cheap, always looks good. |
| 14 | **CRT/VHS stack** | Curvature UV warp, phosphor mask, scanline, chroma bleed, rolling sync bar | The "make it look like it's on a monitor" button everyone wants. |
| 15 | **Audio reactive** | WebAudio AnalyserNode → FFT bands → any parameter | Turn any effect into a music visualizer. Killer demo. |
### 7.3 Evaluation & caching
Topological sort → evaluate → cache by `(nodeId, paramHash, inputHashes, frameIndex)`. Texture pool with LRU eviction so you're not allocating per frame. Nodes declare purity; impure nodes (Feedback, Sim, Time) opt out of caching and get explicit state buffers with ping-pong.
**Determinism requirement:** given the same seed and frame index, output must be bit-identical. Every stochastic node takes an explicit seed; no `Math.random()` anywhere in `core`. This is what makes export match preview — and it's what makes the golden-image tests possible.
---
## 8. Phase 6 — 3D & Physics
### 8.1 The 3D → ASCII renderer
Not a gimmick — this is the feature that makes GLYPHFORGE a category of one.

```
glTF/OBJ loader
  → WebGPU forward+ rasterizer at (cols·ss) × (rows·ss), ss ∈ {2,3,4}
  → G-buffer: albedo(rgba8), normal(rgba16f), depth(r32f), matID(r8u), motion(rg16f)
  → Shading: Lambert + Blinn-Phong + rim + shadow map + optional SSAO
  → Feed G-buffer into glyphify with THREE extra signals:
```

**The three signals that make 3D ASCII look unreal:**
1. **Normal → directional glyph.** Project the surface normal into screen space, take its tangent direction, map to `/ \ | —`. Curved surfaces get hatching that follows the geometry, exactly like a pen-and-ink illustration. This single feature is the money shot.
2. **Depth → charset density.** Near objects use the dense end of the ramp, far objects the sparse end. Instant atmospheric perspective.
3. **Motion vectors (free from the rasterizer) → temporal advection.** Perfect temporal coherence with zero optical-flow cost.
Plus: silhouette edges from depth+normal discontinuity → box-drawing outline pass. Result: hard object outlines with hatched interiors. It looks like a technical illustration that moves.
**Scope control:** ship with a primitive library (cube, sphere, torus, **the donut**, knot, terrain, text-extrude) and an OBJ/glTF importer. Do not build a 3D scene editor in v1 — a transform gizmo, a camera orbit, and 3 lights is enough.
### 8.2 Physics sims
All GPU compute, all deterministic, all outputting to float fields:
| Sim | Method | Notes |
|---|---|---|
| **Particles** | GPU particle system, 1M capacity, curl-noise/attractor/gravity forces, density splat to field | Foundation for several others |
| **Stable fluids** | Semi-Lagrangian advect + Jacobi pressure (40 iters) + vorticity confinement | 128²–512² grid. Dye + velocity fields both exposed. |
| **SPH** | Optional, only if fluids isn't enough. Spatial hash neighbour search. | Cut if time-constrained |
| **Boids** | Spatial hash, 3 rules + optional predator | 10k agents easily |
| **Reaction–diffusion** | Gray–Scott, ping-pong textures, 4 substeps/frame | |
| **Cloth** | Verlet + distance constraints, 8 relaxation iters | Renders beautifully with normal→glyph hatching |
| **Wave** | 2D wave eq, explicit, CFL-limited | |
| **Cellular automata** | Life, Langton's ant, falling-sand, generic rulestring | Falling sand with glyph materials is a whole toy |
---
## 9. Phase 7 — Video I/O & Temporal Coherence
### 9.1 The pipeline

```
File → VideoDecoder (WebCodecs, hardware) → VideoFrame
  → copyExternalImageToTexture (zero-copy where supported)
  → [effects graph]
  → glyphify (with temporal prior)
  → GlyphField
  → renderer → GPUTexture
  → readback → VideoEncoder → mp4-muxer → Blob
```

Run decode + encode in a **worker with OffscreenCanvas**. Never block the main thread. Backpressure: cap in-flight `VideoFrame`s at 4 and always `.close()` them — leaked VideoFrames will hard-stall the decoder and it's a miserable bug to find. Make that a lint rule if you can.
### 9.2 Temporal coherence — the four techniques
This is what separates "cool converter" from "professional tool." Layer all four:
**1. Glyph hysteresis.** In the match cost, add `w_temp · (g ≠ prevGlyph[cell])`. A glyph only changes when the new candidate is *meaningfully* better, not marginally. `w_temp` becomes a "Stability" slider. Set it to 0 and you get the chaotic flickery look people are used to; set it to 0.3 and it looks like a film.
**2. Flow-advected prior.** `prevGlyph` shouldn't be sampled at the same cell — it should follow the motion. Compute pyramidal Lucas–Kanade optical flow (3 levels, 5×5 window) on the luminance field, advect the previous glyph field by it, and use *that* as the prior. Now hysteresis works correctly on panning shots. For 3D scenes, use rasterizer motion vectors instead — free and exact.
**3. Temporal luminance filtering.** Exponential moving average on the input field: `L' = α·L + (1−α)·advect(L'_prev)`. Kills sensor noise before it can perturb the matcher. α ≈ 0.7.
**4. Color deadband.** When quantizing color, only switch to a new palette entry if the Oklab distance exceeds a hysteresis threshold. Stops adjacent-palette-entry strobing on gradients.
**Scene cut detection:** if mean flow magnitude or histogram distance spikes, reset the temporal state — otherwise the first frames after a cut ghost badly.
### 9.3 Export formats
| Format | Notes |
|---|---|
| `.txt` | Plain, with optional frame separators |
| `.ans` / ANSI | 16 / 256 / 24-bit color, with `\x1b[` sequences. Include a `--loop` shell script wrapper option. |
| `.json` | Full structured data, for programmatic use |
| `.svg` | Vector text, per-cell `<tspan>` with fill. Animated SVG via SMIL or CSS keyframes. |
| `.html` | Self-contained page, `<pre>` + CSS animation or JS player. **Embeddable.** |
| `.gif` | via gifenc, with palette optimization |
| `.mp4` / `.webm` | WebCodecs + muxer. H.264 / VP9 / AV1 where available. |
| `.png` sequence | Zipped |
| **Code export** | Emit a standalone player as: JS (canvas), React component, Rust (crossterm), C (ncurses), Python (rich/blessed), Go (tcell), Swift. Nobody else does this and developers will lose their minds. |
| `.gfx` | Native project format — JSON manifest + binary field blobs in a zip |
**Terminal export sanity:** provide a "Terminal-safe" mode that clamps to the target terminal's capabilities (charset ∩ font coverage, color depth) and shows a live preview with the target's cell aspect ratio.
---
## 10. Phase 8 — The AI Layer
Keep AI **out of the pixel path**. Models assist; the renderer stays deterministic.
### 10.1 Monocular depth → 2.5D animation
Depth Anything V2 (small, ~25MB ONNX) via transformers.js on the WebGPU backend. Input: any photo. Output: a depth field.
Then: **parallax animation from a single still.** Slice the depth into N layers, offset each by a camera path (orbit, dolly, sway), inpaint disocclusions with a cheap edge-aware fill, glyphify. A user drops in a photo and gets a moving ASCII scene with real depth. This is the "wait, WHAT" demo.
Bonus: depth also feeds the charset-density signal from §8.1, so photos get atmospheric perspective too.
### 10.2 Segmentation → adaptive charsets
A small U²-Net or SAM-lite for foreground/background, or a semantic segmenter for class labels. Then: **per-region charset and weight profiles.** Faces get a fine ramp with `Photographic` weights; background gets sparse `Technical`. Selectively spending your character budget where the eye looks is exactly what a human artist does, and it produces a visible fidelity jump.
### 10.3 Text → animation (scene-graph DSL)
The LLM authors an **effect graph**, never pixels.

```jsonc
// "a burning skull rotating slowly, green matrix rain behind it"
{
  "layers": [
    { "kind": "generator", "node": "matrixRain",
      "params": { "charset": "katakana", "speed": 0.6, "density": 0.4,
                  "color": "#00ff41", "depthLayers": 3 } },
    { "kind": "scene3d", "mesh": "skull.glb",
      "camera": { "orbit": { "speed": 0.15, "axis": "y" } },
      "shading": { "normalHatching": true, "rimLight": 0.8 } },
    { "kind": "generator", "node": "doomFire",
      "params": { "intensity": 0.9, "wind": [0.1, -1.0] },
      "blend": "screen", "mask": "layer1.silhouette" }
  ],
  "glyphify": { "charset": "ascii-full", "weights": "Dramatic",
                "colorMode": "dual", "temporal": 0.35 }
}
```

Publish this schema as a JSON Schema, validate strictly, and the LLM becomes a reliable authoring surface. Ship a curated prompt→graph example set for few-shot. Every generated graph is fully editable afterward — the AI is a starting point, not a black box.
### 10.4 Style transfer (optional, last)
Fast neural style transfer (a small ONNX model) applied to the *continuous field* before glyphify. Cheap to add once §10.1's ONNX plumbing exists.
---
## 11. Testing, Benchmarking & the Fidelity Metric
### 11.1 The fidelity metric — do this early, it changes everything
**Render the ASCII output back to a bitmap at source resolution, then compare to the source.**

```
source image  →  glyphify  →  GlyphField  →  re-render to bitmap  →  SSIM vs source
```

You now have a **number** that measures how accurate your ASCII is. Every change to the matcher, every weight tweak, every new charset gets scored automatically.
Run it over a fixed corpus (`fixtures/`): portraits, landscapes, text/screenshots, line art, high-frequency texture, low-contrast, high-contrast. Report per-image and mean. Track in CI, fail the build on regression beyond a tolerance.
Metrics to compute: **SSIM** (primary), MS-SSIM, PSNR (secondary), and a gradient-domain SSIM (measures whether edges survived). For video, also compute **temporal SSIM** — frame-to-frame difference of the output vs. frame-to-frame difference of the source. A low temporal-diff ratio means you're not flickering.
> Nobody in ASCII-art tooling does this. It converts "does this look good?" — an argument — into a regression test. It is the single highest-leverage thing in this entire plan.
### 11.2 Test layers
- **Unit** (Vitest): color conversions round-trip, Oklab against reference values, feature extraction invariants, delta encode/decode round-trip, graph topo sort, undo/redo invariants.
- **GPU-vs-CPU parity**: every WGSL pass has a CPU reference in `core`. Assert max abs diff < 1e-4 on fixed inputs. This is how you find the shader bug.
- **Golden glyph fields**: hash the `GlyphField` output for fixed inputs. Any unintended change to the pipeline shows up immediately.
- **Visual regression** (Playwright): screenshot the canvas for a set of documents, compare with a perceptual diff.
- **Perf bench** (`bench/`): fps at 240×135 / 400×225 / 640×360 for each pipeline configuration. Fail on >10% regression.
- **Determinism**: render frame 42 twice from a cold graph, assert bit-identical.
### 11.3 Performance budgets
| Operation | Target |
|---|---|
| Glyphify 240×135, ascii-full, dual color | < 1.5 ms |
| Glyphify 640×360, braille | < 6 ms |
| Full graph (5 FX nodes) 240×135 | < 8 ms (→ 120fps) |
| Video realtime 1080p → 240×135 | 30 fps sustained |
| Optical flow 3-level LK at 480×270 | < 3 ms |
| Fluid sim 256², 40 Jacobi iters | < 4 ms |
| Export 1000 frames → mp4 @ 240×135 | < 90 s |
| Cold app load (interactive) | < 2.5 s |
| Idle memory, 500-frame project | < 400 MB |
---
## 12. Roadmap
| Phase | Deliverable | Est. | Gate |
|---|---|---|---|
| **0** | Scaffold, CI, WebGPU device + capability tiers, `GlyphField`, CPU reference renderer, fixtures | 3–4 d | `pnpm bench` runs, empty grid renders |
| **1** | Glyph atlas, feature extraction, instanced renderer, charsets, font probing | 4–5 d | 240×135 random grid @ 144fps |
| **2** | **The matcher.** Cost function, WGSL argmin, supersampling, dual-cell solve, weight presets, **fidelity harness** | 7–10 d | Portrait at 200×100 is recognizable. SSIM ≥ 0.72 (blocks). |
| **3** | Edge pass (DoG/XDoG + structure tensor + line continuation), color pipeline, dithering, palettes | 5–7 d | Line art converts cleanly. SSIM_grad ≥ 0.6. |
| **4** | Document/layers/timeline/undo, all drawing tools, onion skin, keyframes | 10–14 d | Can hand-animate a 30-frame loop end to end |
| **5** | Effect graph engine, caching, 15 FX from §7.2, audio reactive | 12–16 d | Matrix rain, fire, fluid all shipping |
| **6** | 3D renderer (gbuffer, normal hatching, silhouettes), 4 sims | 10–14 d | Rotating torus with normal-following hatching |
| **7** | WebCodecs I/O, temporal coherence (all 4 techniques), all exporters incl. code export | 8–12 d | 1080p clip converts with no visible shimmer |
| **8** | Depth model, parallax, segmentation charsets, text→graph DSL | 7–10 d | Photo → 2.5D animated ASCII |
| **9** | Project format, OPFS persistence, share links, gallery, onboarding, docs, PWA | 7–10 d | Ship it |
**Total: ~11–16 weeks solo with an agent.** Phases 0–3 are the critical path; everything after is additive. If you have to ship early, **Phases 0–3 + 7 alone is already a better converter than anything that exists.**
---
## 13. Risks & Mitigations
| Risk | Mitigation |
|---|---|
| WebGPU absent / broken driver | Capability tiers. Tier 0 = CPU worker, small grids, no sims. Detect and communicate clearly, never white-screen. |
| Matcher output looks bad and you can't tell why | The CPU reference + fidelity metric + a **debug overlay** that visualizes per-cell cost, chosen glyph, runner-up, and the tile bitmap. Build the overlay in Phase 2, not later. |
| Font metrics differ across platforms | Probe at runtime, ship a bundled webfont (JetBrains Mono / IBM Plex Mono) as the default so output is reproducible. |
| VideoFrame leaks stall decoding | Strict `.close()` discipline, in-flight cap, a dev-mode leak counter assertion. |
| Effect graph becomes an unusable spaghetti UI | Ship **presets first**, graph editor second. 90% of users want a dropdown of 15 great looks, not a node editor. |
| Scope explosion | Phases 4–8 are independently cuttable. The fidelity metric keeps you honest about what actually matters. |
| Memory blowup on long animations | Delta+RLE frame storage from day one, not retrofitted. Budget assert in CI. |
| AI models bloat the bundle | Lazy-load on first use, cache in OPFS, show size before download, make the whole AI layer optional. |
## 14. Anti-goals (write these down, resist them)
- ❌ A general image editor. Glyphs only.
- ❌ Real-time multiplayer collaboration in v1.
- ❌ A full 3D scene editor. Import + orbit + 3 lights.
- ❌ Server-side rendering. Everything client-side; the only backend is optional storage/sharing.
- ❌ Mobile-first UI. Responsive viewer, desktop editor.
- ❌ Supporting every codec. WebCodecs handles what it handles; ffmpeg.wasm is a documented fallback, not a dependency.
- ❌ An LLM in the render loop.
---
## 15. Driving Claude Code
Put `CLAUDE.md` at the repo root before the first prompt. Then work phase by phase — **never** hand it more than one phase at a time.
**Recommended workflow per phase:**
1. `/plan` the phase → have Claude produce a task breakdown and confirm it against `PLAN.md` §for that phase
2. Build the CPU reference implementation + tests **first**
3. Build the GPU implementation, verify against the CPU reference
4. Run `pnpm bench` and `pnpm fidelity`, record the numbers in the PR
5. Commit at every green checkpoint
**Phase kickoff prompts:**
> **P1** — "Read PLAN.md §3 and CLAUDE.md. Implement the glyph atlas: rasterize charsets at 4× supersample into a packed R8 texture, extract the 46-dim feature vector per glyph per §3.2, and probe font metrics at runtime. Include the instanced grid renderer. Write Vitest coverage for feature extraction invariants and a Playwright visual check for the renderer. CPU reference first."
> **P2** — "Read PLAN.md §4. This is the accuracy core — take your time. Implement the cost function in `core/match/cost.ts` as pure TypeScript with full tests, including the coverage-to-luminance calibration LUT. Then port to `gpu/passes/match.wgsl` and assert parity within 1e-4. Then implement dual-cell 2-means in Oklab. Then build the fidelity harness in `bench/` per §11.1 and report baseline SSIM across all fixtures. Also build the per-cell debug overlay described in §13."
> **P3** — "Read PLAN.md §5. Implement the DoG/XDoG edge pass with structure-tensor coherence gating and the line-continuation pass. Then the full color pipeline: Oklab, four quantizers, six dithers, the named palettes. Re-run the fidelity harness and report the delta from the Phase 2 baseline, including gradient-domain SSIM."
...and so on. Each phase ends with fidelity + bench numbers. That's the discipline that makes this work.
---
## Appendix A — Reference reading
- Acerola, *"I Tried Turning Games Into Text"* — the DoG + Sobel + directional-glyph technique that §5.1 extends
- Jos Stam, *"Stable Fluids"* (SIGGRAPH '99) — §8.2
- Winnemöller et al., *"XDoG: An eXtended difference-of-Gaussians"* — §5.1
- Björn Ottosson, *Oklab* — §5.2
- `chafa` source — the canonical dual-color cell solve, §4.4
- Kajiya-style *structure tensor* line integral convolution — for the hatching direction field in §8.1
- `demelere/ASCII-Shaders` — a working reference for the DoG+Sobel pipeline
## Appendix B — The one-paragraph pitch
*GLYPHFORGE turns images, video, and 3D scenes into ASCII that actually looks like the thing. Instead of mapping brightness to a character ramp, it treats every text cell as a tiny image patch and searches a perceptual feature space for the glyph that best reconstructs it — matching structure, tone, and edge orientation simultaneously, with two colors per cell and frame-to-frame stability so video doesn't shimmer. On top of that sits a GPU effects graph with fluid simulation, a real 3D renderer that hatches surfaces along their normals, and an AI layer that turns a single photo into a moving 2.5D scene. It exports to text, ANSI, SVG, MP4, and standalone player code in seven languages. It is, measurably, the most accurate ASCII renderer ever built — and there's a number in CI that proves it.*
