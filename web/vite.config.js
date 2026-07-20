import { defineConfig } from 'vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Zichtbaar versiestempel (profiel + inlogscherm): zo zie je in een oogopslag
// welke build er draait — scheelt gepuzzel bij 'ik zie de fix niet'.
let commit = 'onbekend';
try {
  commit = execSync('git rev-parse --short HEAD', {
    cwd: dirname(fileURLToPath(import.meta.url)),
  }).toString().trim();
} catch { /* geen git beschikbaar (bv. zip-download) */ }
const nu = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const bouwtijd = `${p2(nu.getDate())}-${p2(nu.getMonth() + 1)}-${nu.getFullYear()} ${p2(nu.getHours())}:${p2(nu.getMinutes())}`;

export default defineConfig({
  define: {
    __BOUWSTEMPEL__: JSON.stringify(`${commit} · gebouwd ${bouwtijd}`),
  },
  root: dirname(fileURLToPath(import.meta.url)),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
