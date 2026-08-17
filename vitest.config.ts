import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// tsconfig.base.json has no `include`, which vite-tsconfig-paths treats as
// match-all, so its paths map applies to every test file. Paths must win over
// package `exports` so a built `lib/` never loads a second module-singleton copy.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})
