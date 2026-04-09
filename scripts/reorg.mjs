#!/usr/bin/env node
// One-shot script: reorganize src/ into apps/ + core/ layout and rewrite imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function remapRel(rel) {
  rel = rel.replaceAll('\\', '/');
  if (rel === 'cli.ts') return 'apps/cli/index.ts';
  if (rel === 'mcp/server.ts') return 'apps/mcp-server/index.ts';
  if (rel.startsWith('cli/')) return 'apps/' + rel;
  if (rel.startsWith('api/')) return 'apps/http-api/' + rel.slice(4);
  if (rel.startsWith('dashboard/')) return 'apps/' + rel;
  if (rel.startsWith('admin/oauth/')) return 'core/services/oauth/' + rel.slice('admin/oauth/'.length);
  if (rel.startsWith('services/')) return 'core/services/' + rel.slice('services/'.length);
  if (rel.startsWith('search/')) return 'core/search/' + rel.slice('search/'.length);
  if (rel.startsWith('agent/')) return 'core/indexer/' + rel.slice('agent/'.length);
  if (rel.startsWith('coder/')) return 'core/coder/' + rel.slice('coder/'.length);
  return rel;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(SRC);

// Build old-abs → new-abs map
const pathMap = new Map();
for (const abs of allFiles) {
  const rel = path.relative(SRC, abs).replaceAll('\\', '/');
  const newRel = remapRel(rel);
  pathMap.set(abs, path.join(SRC, newRel));
}

// Resolve import specifier (old layout) to an absolute old path of an existing file
function resolveImport(fromOldAbs, spec) {
  const base = path.resolve(path.dirname(fromOldAbs), spec);
  const stripped = base.replace(/\.js$/, '');
  const candidates = [
    base,
    stripped + '.ts',
    stripped + '.tsx',
    path.join(stripped, 'index.ts'),
    path.join(stripped, 'index.tsx'),
    // Also try specifier without .js already
    base + '.ts',
    base + '.tsx',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function rewriteContent(oldAbs, newAbs, content) {
  // Match: from '...'   from "..."   import('...')   import ( "..." )
  const re = /((?:from\s+|import\s*\(\s*)(['"]))(\.[^'"]*)\2/g;
  return content.replace(re, (m, head, quote, spec) => {
    const targetOld = resolveImport(oldAbs, spec);
    if (!targetOld) return m;
    const targetNew = pathMap.get(targetOld);
    if (!targetNew) return m;
    let rel = path.relative(path.dirname(newAbs), targetNew).replaceAll('\\', '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    rel = rel.replace(/\.tsx?$/, '.js');
    return head + rel + quote;
  });
}

// Pass 1: compute new content
const pending = [];
for (const oldAbs of allFiles) {
  const newAbs = pathMap.get(oldAbs);
  let content = fs.readFileSync(oldAbs);
  if (/\.(ts|tsx|mjs|cjs|js)$/.test(oldAbs)) {
    content = Buffer.from(rewriteContent(oldAbs, newAbs, content.toString('utf8')), 'utf8');
  }
  pending.push({ oldAbs, newAbs, content });
}

// Pass 2: write to new, delete old
for (const { oldAbs, newAbs, content } of pending) {
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  fs.writeFileSync(newAbs, content);
  if (oldAbs !== newAbs) fs.unlinkSync(oldAbs);
}

// Pass 3: remove empty dirs
function rmEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) rmEmpty(path.join(dir, e.name));
  }
  try {
    if (dir !== SRC && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}
rmEmpty(SRC);

console.log(`Moved/rewrote ${pending.length} files.`);
