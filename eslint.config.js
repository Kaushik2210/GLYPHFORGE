// @ts-check
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'

/** Layer boundaries — CLAUDE.md "Layer boundaries". Import in the wrong direction fails the build. */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.wgsl'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'packages/core/src/**' },
        { type: 'gpu', pattern: 'packages/gpu/src/**' },
        { type: 'sim', pattern: 'packages/sim/src/**' },
        { type: 'media', pattern: 'packages/media/src/**' },
        { type: 'ai', pattern: 'packages/ai/src/**' },
        { type: 'ui', pattern: 'packages/ui/src/**' },
        { type: 'apps', pattern: 'apps/*/src/**' },
        { type: 'bench', pattern: 'bench/src/**' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'core', allow: [] },
            { from: 'gpu', allow: ['core'] },
            { from: 'sim', allow: ['core', 'gpu'] },
            { from: 'media', allow: ['core'] },
            { from: 'ai', allow: ['core'] },
            { from: 'ui', allow: ['core', 'gpu', 'sim', 'media', 'ai'] },
            { from: 'apps', allow: ['core', 'gpu', 'sim', 'media', 'ai', 'ui'] },
            { from: 'bench', allow: ['core'] },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
)
