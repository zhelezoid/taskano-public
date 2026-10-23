import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Mini App собирается отдельно от сервера (спека mini-app): статика раздаётся из dist/app
// через src/web/miniapp-api.ts. base '/app/' — Vite подставляет префикс в пути ассетов.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/app/',
  plugins: [preact()],
  build: {
    outDir: '../dist/app',
    emptyOutDir: true,
  },
});
