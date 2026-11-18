import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from GitHub Pages
export default defineConfig({
  // relative paths: works at any Pages URL (repo-name casing included) and locally
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2000 },
  test: { environment: 'node' },
} as any);
