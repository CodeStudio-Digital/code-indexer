#!/usr/bin/env node
/**
 * Post-build: copy src/core/coder/prompts/*.txt into dist/core/coder/prompts/.
 * TypeScript's tsc doesn't copy non-.ts files, so the compiled loader.js
 * would otherwise only find the prompts via its src/ fallback path. Shipping
 * the .txt alongside the compiled loader keeps production deployments self
 * contained (no reliance on the source tree being present at runtime).
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src', 'core', 'coder', 'prompts');
const dstDir = join(root, 'dist', 'core', 'coder', 'prompts');

if (!existsSync(srcDir)) {
  console.warn(`[copy-prompts] source dir missing: ${srcDir}`);
  process.exit(0);
}
mkdirSync(dstDir, { recursive: true });

let count = 0;
for (const entry of readdirSync(srcDir)) {
  if (!entry.endsWith('.txt')) continue;
  copyFileSync(join(srcDir, entry), join(dstDir, entry));
  count++;
}
console.log(`[copy-prompts] copied ${count} prompt file(s) to ${dstDir}`);
