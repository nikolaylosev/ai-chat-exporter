import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // UI tests (`@vitest-environment happy-dom`) run on an extension page address.
    environmentOptions: {
      happyDOM: { url: 'chrome-extension://test-extension/src/ui/export-page/index.html' },
    },
  },
});
