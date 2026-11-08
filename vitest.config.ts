import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // crxjs turns `file.ts?script` into the built script's file name; tests get a fixed one.
      name: 'script-file-name',
      enforce: 'pre',
      resolveId: (id) => (id.endsWith('?script') ? `\0script:${id}` : null),
      load: (id) =>
        id.startsWith('\0script:')
          ? `export default ${JSON.stringify(`assets/${id.split('/').pop()?.replace('?script', '')}-loader.js`)};`
          : null,
    },
  ],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // UI tests (`@vitest-environment happy-dom`) run on an extension page address.
    environmentOptions: {
      happyDOM: { url: 'chrome-extension://test-extension/src/ui/export-page/index.html' },
    },
  },
});
