import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/main/**/*.js'],
      // index.js only wires Electron to the modules below; tests/e2e/smoke.mjs runs it for real.
      exclude: ['src/main/index.js'],
    },
  },
});
