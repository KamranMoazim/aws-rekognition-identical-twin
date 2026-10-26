import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Some AWS SDK browser code still references Node's `global`.
  define: { global: 'globalThis' },
  server: {
    port: 5173,
    // Browser calls /api/*, Vite forwards to the Express server.
    proxy: {
      '/api': { target: 'http://localhost:4000', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
