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
    // React's CommonJS entry picks its production build whenever NODE_ENV is "production". A
    // packaged-build shell exports exactly that, which strips `act` from the test workers
    // (every component test then fails with "act is not a function"). Tests always run in
    // Vitest's own "test" environment, like a shell without NODE_ENV.
    env: { NODE_ENV: 'test' },
  },
})
