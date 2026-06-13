/**
 * Standalone Vite build for the content script.
 *
 * The content script is bundled as a single classic IIFE (no ES modules,
 * no dynamic chunks). This means it doesn't need to be listed in the
 * manifest's `web_accessible_resources` — eliminating the residual WAR
 * surface that @crxjs's MV3 module-mode loader requires.
 *
 * Output: dist/content-script.js (added to dist after the main @crxjs build).
 * The manifest is patched post-build by scripts/patch-manifest.mjs.
 */
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    minify: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/content/recorder.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'content-script.js',
        inlineDynamicImports: true,
        // No chunks; everything inlined.
        manualChunks: undefined,
      },
    },
  },
});
