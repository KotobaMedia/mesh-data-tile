import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const exampleRoot = __dirname;
const workspaceRoot = resolve(__dirname, '../..');
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  root: exampleRoot,
  base,
  server: {
    port: 4173,
    fs: {
      allow: [workspaceRoot],
    },
  },
});
