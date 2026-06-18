#!/usr/bin/env node
/**
 * Vendor the Material Icon Theme SVG set + a trimmed resolution manifest into
 * the dashboard (apps/dashboard/lib/material-icons/). Mirrors fetch-drawio.mjs:
 * downloads a PINNED npm tarball and extracts only what we need — no runtime
 * dependency, no lockfile churn.
 *
 * Output:
 *   apps/dashboard/lib/material-icons/svg/*.svg          (only the reachable icons)
 *   apps/dashboard/lib/material-icons/manifest.generated.json
 *
 *   pnpm icons:fetch                          # pinned DEFAULT_VERSION
 *   MATERIAL_ICONS_VERSION=5.35.0 pnpm icons:fetch
 *
 * The SVGs are imported by lib/material-icons/resolve.ts via import.meta.glob
 * (?url) so they emit as hashed /assets/* — the same mechanism as the rest of
 * the bundle, which works under Electron's mcp://app protocol.
 */
import { mkdtemp, rm, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_VERSION = '5.35.0';
const version = (process.env.MATERIAL_ICONS_VERSION ?? DEFAULT_VERSION).replace(/^v/, '');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'apps', 'dashboard', 'lib', 'material-icons');
const svgDir = path.join(outDir, 'svg');
const url = `https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-${version}.tgz`;

/** basename of an iconDefinition's path, sans `.svg` (the SVG file stem). */
function stemOf(iconDefinitions, def) {
  const entry = iconDefinitions[def];
  if (!entry?.iconPath) return null;
  return path.basename(entry.iconPath).replace(/\.svg$/, '');
}

/** Map { key -> defName } → { key -> svgStem }, dropping unresolved defs. */
function resolveMap(iconDefinitions, src) {
  const out = {};
  for (const [key, def] of Object.entries(src ?? {})) {
    const stem = stemOf(iconDefinitions, def);
    if (stem) out[key] = stem;
  }
  return out;
}

async function main() {
  console.log(`[material-icons] fetching v${version} …`);
  const work = await mkdtemp(path.join(tmpdir(), 'material-icons-'));
  const tarball = path.join(work, 'm.tgz');
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball));

    console.log('[material-icons] extracting …');
    // cwd + RELATIVE names — a Windows `C:\…` arg makes GNU tar treat `C:` as a
    // remote host. Same gotcha handled in fetch-drawio.mjs.
    const ex = spawnSync('tar', ['-xzf', 'm.tgz'], { cwd: work, stdio: 'inherit' });
    if (ex.status !== 0) throw new Error('tar extraction failed — is `tar` on PATH?');

    const pkgDir = path.join(work, 'package');
    const manifestSrc = path.join(pkgDir, 'dist', 'material-icons.json');
    const iconsSrc = path.join(pkgDir, 'icons');
    if (!existsSync(manifestSrc) || !existsSync(iconsSrc)) {
      throw new Error(`unexpected package layout — missing ${path.relative(work, manifestSrc)} or icons/`);
    }

    const m = JSON.parse(await readFile(manifestSrc, 'utf8'));
    const defs = m.iconDefinitions ?? {};

    const trimmed = {
      version,
      fileNames: resolveMap(defs, m.fileNames),
      fileExtensions: resolveMap(defs, m.fileExtensions),
      folderNames: resolveMap(defs, m.folderNames),
      folderNamesExpanded: resolveMap(defs, m.folderNamesExpanded),
      defaults: {
        file: stemOf(defs, m.file) ?? 'file',
        folder: stemOf(defs, m.folder) ?? 'folder',
        folderExpanded: stemOf(defs, m.folderExpanded) ?? 'folder-open',
      },
    };

    // Reachable stems = every value across the maps + the three defaults.
    const reachable = new Set([
      ...Object.values(trimmed.fileNames),
      ...Object.values(trimmed.fileExtensions),
      ...Object.values(trimmed.folderNames),
      ...Object.values(trimmed.folderNamesExpanded),
      ...Object.values(trimmed.defaults),
    ]);

    // Fresh svg dir.
    await rm(svgDir, { recursive: true, force: true });
    await mkdir(svgDir, { recursive: true });
    const available = new Set((await readdir(iconsSrc)).filter((f) => f.endsWith('.svg')).map((f) => f.replace(/\.svg$/, '')));
    let copied = 0;
    const missing = [];
    for (const stem of reachable) {
      if (!available.has(stem)) { missing.push(stem); continue; }
      await cp(path.join(iconsSrc, `${stem}.svg`), path.join(svgDir, `${stem}.svg`));
      copied++;
    }

    await writeFile(path.join(outDir, 'manifest.generated.json'), `${JSON.stringify(trimmed, null, 0)}\n`);
    console.log(`[material-icons] copied ${copied} icons → ${path.relative(repoRoot, svgDir)}`);
    if (missing.length) console.warn(`[material-icons] ${missing.length} referenced icons missing (skipped): ${missing.slice(0, 8).join(', ')}…`);
    console.log(`[material-icons] manifest → ${path.relative(repoRoot, path.join(outDir, 'manifest.generated.json'))}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[material-icons] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
