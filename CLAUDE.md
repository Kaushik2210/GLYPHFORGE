# CLAUDE.md — GLYPHFORGE
Persistent context for Claude Code. Read this before every task. `PLAN.md` has the full design; this file has the rules.
---
## What this is
A GPU-native ASCII motion engine in the browser. Images, video, 3D scenes, and physics sims get converted to character grids via a perceptual glyph matcher, composited through an effects graph, and exported to text/ANSI/SVG/MP4/player-code.
**The core thesis:** a text cell is not a pixel — it is a small binary image patch with ~200 possible values. Choosing the right one is a nearest-neighbour search in a perceptual feature space. Never `ramp[luminance * ramp.length]`.
---
## Non-negotiable invariants
Violating any of these is a bug even if tests pass.
1. **Linear light.** All image math happens in linear RGB. sRGB→linear on ingest, linear→sRGB on display. Never do arithmetic on sRGB values.
2. **Oklab for perception.** Color distance, quantization, clustering, and dithering use Oklab. Never Euclidean RGB distance.
3. **One quantization step.** Effects operate on continuous float fields. `Glyphify` is the *only* place the pipeline becomes discrete. Never chain glyph→glyph→glyph transformations that re-quantize.
4. **Determinism.** Same seed + same frame index ⇒ bit-identical output. No `Math.random()`, `Date.now()`, or `performance.now()` in `packages/core`, `packages/gpu`, or `packages/sim`. Stochastic nodes take an explicit seed. This is what makes export match preview.
5. **Every GPU pass has a CPU reference.** WGSL in `packages/gpu/passes/*.wgsl` must have a matching TypeScript implementation in `packages/core`. Parity test: max abs diff < 1e-4. This is how shader bugs get found — do not skip it.
6. **SoA, not AoS.** `GlyphField` is parallel typed arrays (`ch: Uint16Array`, `fg: Uint32Array`, `bg: Uint32Array`, `flags: Uint8Array`). Never an array of cell objects.
7. **No per-cell DOM or canvas2d.** The grid renders as one instanced draw call against the glyph atlas. If you find yourself writing `fillText` in a loop, stop.
8. **`VideoFrame` and `GPUTexture` are closed/destroyed explicitly.** Leaked VideoFrames hard-stall the decoder. Max 4 in flight.
9. **Frames are stored as keyframe + RLE delta.** Never naive full-frame arrays — a 500-frame project blows past 100MB instantly.
10. **Sample the source at ≥ cell-bitmap resolution.** If cells are 8×16 px, sample the source at 8×16 per cell minimum. Mismatched sampling is the #1 cause of bad-looking output.
---
## Layer boundaries

```
core  →  (nothing)              zero DOM, zero React, zero WebGPU. Runs in node.
gpu   →  core                   WebGPU backend. No React.
sim   →  core, gpu               physics
media →  core                   WebCodecs
ai    →  core                   ONNX models
ui    →  everything             React. Owns pixels and events only.
apps  →  everything
```

Import in the wrong direction and the build fails (enforced by `eslint-plugin-boundaries`). If you need something from `ui` in `core`, the abstraction is wrong.
---
## Stack
Vite 6 · React 19 · TypeScript 5.7 strict · WebGPU (WGSL) with WebGL2 fallback · Zustand + Immer · Tailwind 4 + shadcn/ui · WebCodecs + mp4-muxer/webm-muxer · OPFS · Comlink · transformers.js · Vitest + Playwright · pnpm workspaces
TypeScript config: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any`. No non-null `!` without an adjacent comment justifying it.
---
## Conventions
- **Files:** `kebab-case.ts`. **Types/classes:** `PascalCase`. **Functions/vars:** `camelCase`. **Constants:** `SCREAMING_SNAKE`. **WGSL:** `snake_case` for locals, `camelCase` for bindings (match the TS side).
- **No barrel files** except one per package root. They wreck tree-shaking and create cycles.
- **Errors:** typed `Result<T, E>` in `core` for recoverable failures; throw only for programmer error.
- **Comments explain *why*, never *what*.** The one exception: shader math gets a comment naming the paper or technique.
- **Magic numbers:** every tuning constant lives in a named `const` with a comment giving its range and effect. Matcher weights, thresholds, and sigmas are user-facing parameters — treat them as such from the start.
- **Commits:** conventional commits. `feat(match): dual-cell oklab 2-means solve`.
---
## Performance budgets (fail CI on >10% regression)
| Operation | Budget |
|---|---|
| Glyphify 240×135, ascii-full, dual color | 1.5 ms |
| Glyphify 640×360, braille | 6 ms |
| Full graph, 5 FX nodes, 240×135 | 8 ms |
| Optical flow, 3-level LK @ 480×270 | 3 ms |
| Fluid sim 256², 40 Jacobi iters | 4 ms |
| 1080p video → 240×135 realtime | 30 fps sustained |
| Cold load to interactive | 2.5 s |
| Idle memory, 500-frame project | 400 MB |
Zero allocations in the per-frame hot path. Pool textures and buffers. If you allocate in a render loop, the bench will catch it — but don't write it in the first place.
---
## The fidelity metric — read this
`pnpm fidelity` renders the ASCII output **back to a bitmap** and measures SSIM against the source across `fixtures/`.
**Every PR that touches the matcher, edge pass, color pipeline, or charsets must report the before/after fidelity numbers.** "Looks better to me" is not evidence. The number is.
Current baselines live in `bench/baselines.json`. Regressions beyond tolerance fail CI. If you intentionally trade fidelity for something else (speed, style), update the baseline in the same commit with a comment explaining why.
Metrics: SSIM (primary), gradient-domain SSIM (did edges survive?), temporal SSIM (is video shimmering?), PSNR (secondary).
---
## The matcher cost function
`packages/core/match/cost.ts` is the most important file in the repo. Change it carefully.

```
cost(tile, glyph) = w_struct · D_struct   // NCC on mean-subtracted 4×8 patches
                  + w_tone   · D_tone     // |mean(tile) − calibratedLuma(glyph)|
                  + w_edge   · D_edge     // circular L1 on 8-bin orientation hist
                  + w_temp   · [g ≠ prior] // temporal hysteresis
                  + w_prior  · penalty(g) // charset preference
```

- `D_struct` **must** mean-subtract before correlating. That's what decouples shape from brightness.
- `D_tone` uses the **calibrated** glyph luminance from the LUT, not raw ink coverage. Anti-aliasing makes them differ significantly.
- `prior` for video is the **flow-advected** previous glyph field, not the same-cell previous glyph.
- Weight presets: `Photographic`, `Technical`, `Dramatic`, `Classic`. Don't hardcode weights.
---
## Debugging output that looks wrong
Use the debug overlay (`ui/canvas/DebugOverlay.tsx`) before guessing. It shows, per hovered cell: the source tile bitmap, the chosen glyph bitmap, the runner-up, and each cost term's contribution. Nine times out of ten it immediately tells you which term is misbehaving.
Common causes, in order of likelihood:
1. Source sampled at the wrong resolution (invariant #10)
2. sRGB/linear confusion (invariant #1)
3. Cell aspect ratio wrong — probe the font, don't assume 0.5
4. `D_tone` using raw coverage instead of the calibrated LUT
5. Structure-tensor coherence gate too loose → scratchy noise everywhere
6. Error-diffusion dither on video → violent flicker (use blue noise / Bayer instead)
---
## Testing requirements
Every phase ships with:
- Unit tests for pure functions in `core`
- GPU↔CPU parity test for every new WGSL pass
- Golden `GlyphField` hash for fixed inputs
- Determinism test (render frame N twice, assert identical)
- Bench entry if it's in the hot path
- Fidelity delta if it touches the conversion pipeline
Don't mark a phase complete with failing tests or an unreported fidelity regression.
---
## Working style
- **One phase at a time.** Do not start Phase N+1 work while Phase N has open tests.
- **CPU reference first, GPU second.** Always. It's slower to write and far faster to debug.
- **Presets before the node editor.** Users want 15 great looks in a dropdown; the graph UI is for the 10%.
- Prefer deleting code to adding flags. If a parameter has never been changed from its default, it isn't a parameter.
- When a task is ambiguous, ask before building — a wrong matcher rewrite costs days.
---
## Anti-goals
Do not build: a general image editor · multiplayer · a 3D scene editor · server-side rendering · mobile-first editing UI · universal codec support · an LLM in the render loop.
The AI layer authors effect graphs. It never touches pixels.
