import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Relative base so the built prototype can be served from any path.
export default defineConfig({
  base: './',
  plugins: [preact()],
});
