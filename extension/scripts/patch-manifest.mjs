#!/usr/bin/env node
/**
 * Post-build manifest patcher.
 *
 * The main Vite/@crxjs build does not see the content script (we removed it
 * from manifest.json so @crxjs leaves it alone). This script:
 *   1. Adds the IIFE content-script entry pointing at the second-pass output.
 *   2. Strips any web_accessible_resources entries — none should be required
 *      because the content script is now a classic IIFE that Chrome injects
 *      directly without going through the extension URL.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const distDir = process.argv[2] ?? 'dist';
const manifestPath = resolve(process.cwd(), distDir, 'manifest.json');
const contentScriptPath = resolve(process.cwd(), distDir, 'content-script.js');

if (!existsSync(manifestPath)) {
  console.error(`[patch-manifest] manifest not found at ${manifestPath}`);
  process.exit(1);
}
if (!existsSync(contentScriptPath)) {
  console.error(
    `[patch-manifest] content-script.js not found at ${contentScriptPath} — did the IIFE build run?`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

manifest.content_scripts = [
  {
    matches: ['<all_urls>'],
    js: ['content-script.js'],
    run_at: 'document_idle',
    // Run in every frame so iframed UI (Stripe Checkout, OAuth pop-ins,
    // embedded sign-in widgets) is captured. The recorder uses
    // window.frameElement walks to translate per-frame click rects into
    // top-frame coordinates; cross-origin frames omit the rect overlay.
    all_frames: true,
  },
];

const warBefore = manifest.web_accessible_resources;
if (Array.isArray(warBefore)) {
  delete manifest.web_accessible_resources;
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

console.log(
  `[patch-manifest] OK — content_scripts -> content-script.js; web_accessible_resources ${
    warBefore ? 'removed' : 'absent'
  }.`,
);
