#!/usr/bin/env node
/**
 * Bulk string-replace of import aliases. For phase boundaries where the
 * spec changes (e.g. company extracted out of code-agent), we just need
 * a literal substitution across all .ts/.tsx files.
 *
 * Usage: node scripts/rewrite-aliases.mjs <from> <to> [<from> <to> ...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('Usage: node scripts/rewrite-aliases.mjs <from> <to> [<from> <to> ...]');
  process.exit(1);
}
const pairs = [];
for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);

const files = await glob(['src/**/*.{ts,tsx}', 'packages/**/src/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'], {
  cwd: ROOT,
  ignore: ['**/node_modules/**', '**/dist/**'],
});

let changed = 0;
let total = 0;
for (const f of files) {
  const abs = resolve(ROOT, f);
  const orig = readFileSync(abs, 'utf8');
  let updated = orig;
  let fileCount = 0;
  for (const [from, to] of pairs) {
    const before = updated;
    updated = updated.split(from).join(to);
    if (updated !== before) {
      const occurrences = (before.match(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      fileCount += occurrences;
    }
  }
  if (updated !== orig) {
    writeFileSync(abs, updated);
    changed++;
    total += fileCount;
    console.log(`  ${f}: ${fileCount}`);
  }
}
console.log(`\n${changed} files changed, ${total} substitutions`);
