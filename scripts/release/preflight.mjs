/**
 * Release preflight — the checks that turn a 20-minute build failure into a
 * 2-second one. Every item here has actually broken a build of this repo.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * better-sqlite3 is compiled against ONE ABI at a time. The desktop app needs
 * Electron's; `pnpm rebuild` / a stray `npm install` flips it back to Node's and
 * the packaged app then dies on the first `new Database()`. Probing under this
 * Node process inverts the logic: a SUCCESSFUL open means the binary is
 * Node-ABI, which is exactly what must not ship.
 */
export function checkNativeAbi(root) {
  const code =
    "try{new(require('better-sqlite3'))(':memory:');console.log('NODE_ABI')}" +
    "catch(e){const m=/NODE_MODULE_VERSION (\\d+)/.exec(e.message);console.log(m?'ELECTRON_ABI '+m[1]:'ERROR '+e.message)}";
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (out.startsWith('ELECTRON_ABI')) return { ok: true, abi: out.split(' ')[1] };
  if (out === 'NODE_ABI') {
    return {
      ok: false,
      hint:
        'better-sqlite3 is built for Node, not Electron — the packaged app would crash on any DB call.\n' +
        '       Fix with `pnpm run electron:rebuild`.',
    };
  }
  return { ok: false, hint: `could not determine better-sqlite3 ABI: ${out || r.stderr}` };
}

/**
 * electron-builder resolves production dependencies from the ROOT package.json
 * only — a dependency declared just in `packages/<x>/package.json` is installed
 * for dev but never packaged, and surfaces as ERR_MODULE_NOT_FOUND at launch.
 *
 * ADVISORY, not a gate: such a package may still ship because something in the
 * root tree pulls it in transitively, and code that imports it may not even be
 * reachable. Neither is knowable before the artifact exists — the module
 * closure check in verify.mjs inspects the real asar and is the actual gate.
 * Failing here would block every release on packages that are in fact fine.
 */
export function checkWorkspaceDeps(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(rootPkg.dependencies || {}));
  const pkgDir = join(root, 'packages');
  if (!existsSync(pkgDir)) return { ok: true, missing: [] };

  const missing = [];
  for (const name of readdirSync(pkgDir)) {
    const manifest = join(pkgDir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); } catch { continue; }
    for (const dep of Object.keys(pkg.dependencies || {})) {
      // Workspace siblings are bundled as compiled output under dist/, not as
      // node_modules entries, so they are never expected in the root manifest.
      if (dep.startsWith('@mcp/') || dep.startsWith('@cloudstudio/')) continue;
      if (!declared.has(dep)) missing.push({ dep, pkg: `packages/${name}` });
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Informational only — this repo builds from a feature branch by design. */
export function gitState(root) {
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? '';
  return {
    branch: run(['branch', '--show-current']),
    dirtyFiles: run(['status', '--porcelain']).split('\n').filter(Boolean).length,
    head: run(['rev-parse', '--short', 'HEAD']),
  };
}

/** `gh` is how we publish without asking the user to mint a GH_TOKEN by hand. */
export function checkGhAuth() {
  const version = spawnSync('gh', ['--version'], { shell: true, encoding: 'utf8' });
  if (version.status !== 0) return { ok: false, hint: 'GitHub CLI (`gh`) not found — needed to publish.' };
  const auth = spawnSync('gh', ['auth', 'status'], { shell: true, encoding: 'utf8' });
  if (auth.status !== 0) return { ok: false, hint: 'Not logged in to GitHub — run `gh auth login`.' };
  return { ok: true };
}
