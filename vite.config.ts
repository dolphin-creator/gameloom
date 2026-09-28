import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        'index.html': 'index.html',
        'temple.html': 'temple.html',
        'ruins.html': 'ruins.html',
        'dungeon.html': 'dungeon.html',
        'outpost.html': 'outpost.html',
        'v02_test.html': 'v02_test.html',
      },
    },
  },
});
