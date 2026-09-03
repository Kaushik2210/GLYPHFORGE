# GLYPHFORGE

[![CI](https://github.com/Kaushik2210/GLYPHFORGE/actions/workflows/ci.yml/badge.svg)](https://github.com/Kaushik2210/GLYPHFORGE/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-all%20rights%20reserved-lightgrey)

**A GPU-native ASCII art engine for the browser.** Images are converted to character grids through a perceptual glyph matcher — not a brightness ramp — preserving real structure, color, and detail.

**[Live demo →](https://glyphforge-web.vercel.app)**

## What makes this different

Most "image to ASCII" tools pick a character by mapping average brightness onto a fixed ramp (`" .:-=+*#%@"`). GLYPHFORGE treats each character cell as what it actually is: a small binary image patch with ~95 possible shapes. Choosing the right one is a nearest-neighbour search in a perceptual feature space, not a lookup table.

- **Structure-aware matching** — normalized cross-correlation on mean-subtracted tile patches picks glyphs by *shape*, not just brightness
- **Dual-cell color** — each cell can carry two colors (foreground/background) solved via 2-means clustering in Oklab space, so hard edges stay sharp instead of averaging into mud
- **Linear-light color pipeline** — all image math happens in linear RGB; sRGB conversion only happens at the boundaries
- **Perceptual color space (Oklab)** — color distance and clustering use Oklab, not naive Euclidean RGB
- **Edge-aware overrides** — a DoG/Sobel pass detects clean, coherent edges and overrides the matched glyph with a directional character (`- | / \`)
- **GPU-instanced rendering** — the whole grid renders as a single instanced draw call against a glyph atlas texture, not per-cell canvas/DOM text

## Try it

- **Drag and drop** an image onto the live preview, or click to browse
- Pick a style preset (**Balanced**, **Photographic**, **Technical**, **Dramatic**, **Classic**) — each rebalances the structure/tone/edge weights differently
- **Export** as PNG, plain text, or ANSI (with real terminal color codes) — exports render at the pipeline's full detail ceiling, independent of your screen size
- Fully responsive — fits any screen from phone to ultrawide monitor without scrolling or blur

## Tech stack

| | |
|---|---|
| **Framework** | React 19 + Vite 6 + TypeScript 5.7 (strict) |
| **Rendering** | WebGL2 instanced rendering |
| **State** | Zustand |
| **Testing** | Vitest |
| **Package management** | pnpm workspaces (monorepo) |

## Architecture

```
packages/core   zero-DOM, zero-React glyph matching / color / edge-detection engine — runs in Node
packages/gpu    WebGL2 rendering backend, glyph atlas rasterization
apps/web        React UI — owns pixels and events only, imports everything else
bench/          performance and fidelity benchmarking harness
```

Layer boundaries are enforced by `eslint-plugin-boundaries` — `core` never imports from `gpu` or `apps/web`, so the matching engine stays testable in plain Node with no browser APIs.

### Core invariants

- **Linear light math.** All image math happens in linear RGB; sRGB conversion only at the input/output boundary.
- **One quantization step.** `Glyphify` is the only place the pipeline becomes discrete — effects never chain glyph→glyph.
- **Determinism.** Same seed + same frame index produces bit-identical output. No `Math.random()` or wall-clock reads in the core matching pipeline.
- **Every algorithm has a CPU reference implementation**, tested independently of any GPU path.

## Getting started

Requires Node ≥20 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Kaushik2210/GLYPHFORGE.git
cd GLYPHFORGE
pnpm install
pnpm dev
```

Open the printed local URL — the dev server runs the `apps/web` package on Vite.

### Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start the web app's dev server |
| `pnpm build` | Build all packages |
| `pnpm test` | Run the full test suite (Vitest) |
| `pnpm typecheck` | Type-check every workspace package |
| `pnpm lint` | Lint the whole repo (ESLint, `--max-warnings 0`) |
| `pnpm bench` | Run performance benchmarks |
| `pnpm fidelity` | Measure conversion fidelity (SSIM) against reference fixtures |

## Quality bar

Every PR is expected to pass `pnpm typecheck`, `pnpm lint`, and `pnpm test` before merging. Changes to the matcher, color pipeline, or charsets are expected to report before/after fidelity numbers rather than relying on visual judgement alone — see `CLAUDE.md` for the full set of engineering invariants this project holds itself to.

## License

All rights reserved. This code is public for portfolio/reference purposes; it is not licensed for reuse, modification, or redistribution.
