import type { GlyphField } from '@glyphforge/core'

/**
 * WebGL2 fallback path for the instanced glyph grid (invariant #7 / PLAN §1).
 * One draw call, `cols*rows` instances: per-instance grid position, fg/bg color, and
 * charIndex; the fragment shader samples a packed glyph-atlas strip texture and mixes
 * fg/bg by coverage. This is the real glyph renderer (Phase 1), not a placeholder —
 * WebGPU gets the equivalent compute+render path once Phase 1's WGSL passes land.
 */
export interface InstancedGridRenderer {
  resize(cols: number, rows: number): void
  /** `cellW` is the atlas's per-glyph cell width in texels — used to inset UV sampling
   * by half a texel so LINEAR filtering can't bleed into the neighboring glyph. */
  setAtlas(texture: WebGLTexture, glyphCount: number, cellW: number): void
  upload(field: GlyphField): void
  draw(viewportW: number, viewportH: number): void
  dispose(): void
}

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 quadPos;      // unit quad, [0,1]
layout(location = 1) in vec2 gridPos;      // per-instance cell (x,y)
layout(location = 2) in vec4 fgColor;      // per-instance
layout(location = 3) in vec4 bgColor;      // per-instance
layout(location = 4) in float charIndex;   // per-instance, index into the atlas strip
uniform vec2 uGridDims;   // cols, rows
out vec4 vBg;
out vec4 vFg;
out vec2 vUv;
out float vCharIndex;
void main() {
  vec2 cellSizeNdc = 2.0 / uGridDims;
  vec2 originNdc = vec2(-1.0, 1.0);
  vec2 cellOriginNdc = originNdc + vec2(gridPos.x, -gridPos.y) * cellSizeNdc;
  vec2 localNdc = quadPos * cellSizeNdc * vec2(1.0, -1.0);
  gl_Position = vec4(cellOriginNdc + localNdc, 0.0, 1.0);
  vBg = bgColor;
  vFg = fgColor;
  vUv = quadPos; // quadPos.y=0 is the top of the cell, matching row 0 of the atlas bitmap
  vCharIndex = charIndex;
}
`

const FRAGMENT_SRC = `#version 300 es
// highp, not mediump: mediump is as coarse as ~10 bits of mantissa on some mobile GPUs,
// which visibly bands fg/bg color mixes across a gradient-heavy image.
precision highp float;
in vec4 vBg;
in vec4 vFg;
in vec2 vUv;
in float vCharIndex;
uniform sampler2D uAtlas;
uniform float uGlyphCount;
uniform float uHalfTexelInset;
out vec4 outColor;
void main() {
  // Each glyph occupies one cellW-texel slice of the atlas strip. LINEAR filtering
  // samples up to half a texel past the edges of that slice, bleeding in ink from
  // the adjacent glyph — visible as faint smudges on the left/right edge of every
  // character. Clamping into the slice by half a texel keeps every sample inside it.
  float localU = clamp(vUv.x, uHalfTexelInset, 1.0 - uHalfTexelInset);
  vec2 uv = vec2((vCharIndex + localU) / max(uGlyphCount, 1.0), vUv.y);
  float coverage = texture(uAtlas, uv).r;
  outColor = mix(vBg, vFg, coverage);
}
`

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('createShader failed')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile error: ${log ?? 'unknown'}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('createProgram failed')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    throw new Error(`Program link error: ${log ?? 'unknown'}`)
  }
  return program
}

export function createInstancedGridRenderer(gl: WebGL2RenderingContext): InstancedGridRenderer {
  const program = linkProgram(
    gl,
    compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC),
    compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC),
  )
  const uGridDims = gl.getUniformLocation(program, 'uGridDims')
  const uAtlas = gl.getUniformLocation(program, 'uAtlas')
  const uGlyphCount = gl.getUniformLocation(program, 'uGlyphCount')
  const uHalfTexelInset = gl.getUniformLocation(program, 'uHalfTexelInset')

  const quadBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

  const gridPosBuf = gl.createBuffer()
  const fgBuf = gl.createBuffer()
  const bgBuf = gl.createBuffer()
  const charIndexBuf = gl.createBuffer()

  const vao = gl.createVertexArray()
  if (!vao) throw new Error('createVertexArray failed')
  gl.bindVertexArray(vao)

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, gridPosBuf)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(1, 1)

  gl.bindBuffer(gl.ARRAY_BUFFER, fgBuf)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0)
  gl.vertexAttribDivisor(2, 1)

  gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
  gl.enableVertexAttribArray(3)
  gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0)
  gl.vertexAttribDivisor(3, 1)

  gl.bindBuffer(gl.ARRAY_BUFFER, charIndexBuf)
  gl.enableVertexAttribArray(4)
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(4, 1)

  gl.bindVertexArray(null)

  let cols = 0
  let rows = 0
  let instanceCount = 0
  let atlasTexture: WebGLTexture | null = null
  let glyphCount = 1
  let halfTexelInset = 0
  let charIndexScratch = new Float32Array(0)

  function resize(newCols: number, newRows: number): void {
    cols = newCols
    rows = newRows
    instanceCount = cols * rows
    charIndexScratch = new Float32Array(instanceCount)
    const positions = new Float32Array(instanceCount * 2)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 2
        positions[i] = x
        positions[i + 1] = y
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPosBuf)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
  }

  return {
    resize,

    setAtlas(texture: WebGLTexture, count: number, cellW: number) {
      atlasTexture = texture
      glyphCount = count
      halfTexelInset = cellW > 0 ? 0.5 / cellW : 0
    },

    upload(field: GlyphField) {
      if (field.cols !== cols || field.rows !== rows) {
        resize(field.cols, field.rows)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, fgBuf)
      gl.bufferData(gl.ARRAY_BUFFER, field.fg, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
      gl.bufferData(gl.ARRAY_BUFFER, field.bg, gl.DYNAMIC_DRAW)

      for (let i = 0; i < field.ch.length; i++) {
        charIndexScratch[i] = field.ch[i] ?? 0
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, charIndexBuf)
      gl.bufferData(gl.ARRAY_BUFFER, charIndexScratch, gl.DYNAMIC_DRAW)
    },

    draw(viewportW: number, viewportH: number) {
      gl.viewport(0, 0, viewportW, viewportH)
      gl.useProgram(program)
      gl.uniform2f(uGridDims, Math.max(cols, 1), Math.max(rows, 1))
      gl.uniform1f(uGlyphCount, glyphCount)
      gl.uniform1f(uHalfTexelInset, halfTexelInset)
      if (atlasTexture) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
        gl.uniform1i(uAtlas, 0)
      }
      gl.bindVertexArray(vao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount)
      gl.bindVertexArray(null)
    },

    dispose() {
      gl.deleteBuffer(quadBuf)
      gl.deleteBuffer(gridPosBuf)
      gl.deleteBuffer(fgBuf)
      gl.deleteBuffer(bgBuf)
      gl.deleteBuffer(charIndexBuf)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(program)
    },
  }
}
