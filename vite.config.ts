/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4330,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // Unit tests read the French catalog: their expectations predate the English one.
    setupFiles: ['src/i18n/test-setup.ts'],
  },
})
