/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// The running version shown in Settings and the footer, and the service worker's cache name.
// HOHE_VERSION overrides it (the image build passes the release version).
function appVersion(): string {
  if (process.env.HOHE_VERSION) return process.env.HOHE_VERSION;
  try {
    return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const VERSION = appVersion();

/** Emit /sw.js with this build's version and the full list of files it must precache. */
function serviceWorker(): Plugin {
  return {
    name: 'hohe-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => f !== 'index.html' && !f.endsWith('.map'))
        .map((f) => `/${f}`);
      const publicFiles = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
      const src = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8')
        .replace("const VERSION = '__VERSION__';", `const VERSION = ${JSON.stringify(VERSION)};`)
        .replace('const ASSETS = __ASSETS__;', `const ASSETS = ${JSON.stringify([...assets, ...publicFiles].sort())};`);
      if (src.includes("'__VERSION__'") || src.includes('= __ASSETS__')) this.error('sw.js placeholders were not replaced');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [preact(), serviceWorker()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    // `npm run dev` against a local `hohe serve` on 127.0.0.1:8080.
    proxy: { '/api': 'http://127.0.0.1:8080', '/version': 'http://127.0.0.1:8080', '/healthz': 'http://127.0.0.1:8080' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
