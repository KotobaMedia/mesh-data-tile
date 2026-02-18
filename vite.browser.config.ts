import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/browser',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: 'src/browser.ts',
      name: 'MeshDataTile',
      formats: ['es', 'iife'],
      fileName: (format) => `mesh-data-tile-browser.${format}.js`,
    },
    rollupOptions: {
      external: ['maplibre-gl'],
    },
    target: 'es2020',
    minify: false,
  },
});
