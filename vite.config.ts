import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import manifest from './src/manifest.ts';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    target: 'chrome120',
    rollupOptions: {
      // Pages that the manifest does not reference directly.
      input: {
        offscreen: 'src/offscreen/offscreen.html',
        export: 'src/ui/export-page/index.html',
        messages: 'src/ui/messages/index.html',
        search: 'src/ui/search/index.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
