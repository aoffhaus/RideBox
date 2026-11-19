import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the Cloudflare Worker (wrangler.jsonc)
export default defineConfig({
  // relative paths: works at any URL and locally
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', exclude: ['**/node_modules/**', '.claude/**'] },
} as any);
