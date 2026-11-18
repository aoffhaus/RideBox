import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from https://<user>.github.io/ridebox/
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/ridebox/' : '/',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2000 },
  test: { environment: 'node' },
} as any);
