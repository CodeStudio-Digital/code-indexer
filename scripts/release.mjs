#!/usr/bin/env node
/**
 * One-command release: preflight → build → verify → publish.
 *
 * The ordering is the point. Every stage can only be reached from a green one,
 * and publishing is last so a broken artifact can never reach users. Each
 * preflight item exists because it has already cost this repo a full build.
 *
 *   pnpm release                    preflight + build + verify (no publishing)
 *   pnpm release --publish          ...and create the GitHub Release
 *   pnpm release --skip-build       verify (and optionally publish) what is on disk
 *   pnpm release --dry-run          show what would happen, touch nothing
 *
 * Flags: --version=<x.y.z> release under a different version (package.json is
 * left alone; pass a version you have already bumped), --draft, --prerelease,
 * --yes (skip the interactive confirm — required when stdin is not a TTY),
 * --notes="..." (defaults to GitHub's generated notes).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGhAuth,
  checkNativeAbi,
  checkWorkspaceDeps,
  gitState,
} from './release/preflight.mjs';
import { verifyBuild } from './release/verify.mjs';
import { confirm, publishRelease, releaseAssets, releaseExists, targetRepo } from './release/publish.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

if (has('--help') || has('-h')) {
  console.log(`
CodeStudio Local release — preflight → build → verify → publish

  pnpm release                     preflight, build and verify (publishes nothing)
  pnpm release --publish           ...and create the GitHub Release
  pnpm release --skip-build        verify what is already in dist/electron-builder
  pnpm release --dry-run           report what would happen, change nothing

Options
  --version=<x.y.z>   release as this version (bump package.json yourself first)
  --notes="..."       release notes (default: GitHub generates them)
  --draft             create the release as a draft
  --prerelease        mark the release as a prerelease
  --yes               skip the confirmation prompt (required for non-interactive runs)

Publishing uploads the verified standalone installer under a local-v tag.
`);
  process.exit(0);
}

const wantPublish = has('--publish');
const skipBuild = has('--skip-build');
const dryRun = has('--dry-run');
const outputDir = path.join(root, 'dist/electron-builder');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = value('--version') ?? pkg.version;
const tag = `local-v${version}`;

const ICON = { ok: '✓', bad: '✗', warn: '!' };
let failed = false;

function step(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function line(ok, label, detail) {
  const mark = ok === 'warn' ? ICON.warn : ok ? ICON.ok : ICON.bad;
  console.log(`  ${mark} ${label}${detail ? `\n      ${detail}` : ''}`);
  if (ok === false) failed = true;
}
function die(message) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

// ── 1. Preflight ────────────────────────────────────────────────
step(`Preflight — CodeStudio Local ${version}`);

const git = gitState(root);
line(true, `git ${git.branch} @ ${git.head}`, git.dirtyFiles > 0 ? `${git.dirtyFiles} uncommitted file(s)` : '');

const abi = checkNativeAbi(root);
line(abi.ok, abi.ok ? `better-sqlite3 built for Electron (ABI ${abi.abi})` : 'better-sqlite3 ABI', abi.hint);

// Advisory only — see checkWorkspaceDeps. The module closure check against the
// packaged asar is what actually decides whether anything is missing.
const deps = checkWorkspaceDeps(root);
line(
  deps.ok ? true : 'warn',
  deps.ok
    ? 'runtime dependencies all present in the root manifest'
    : `${deps.missing.length} dependency(ies) declared only in a workspace package`,
  deps.ok
    ? ''
    : `${deps.missing.map((m) => `${m.dep} (${m.pkg})`).join(', ')}\n      may still ship transitively — the module closure check decides`,
);

if (wantPublish) {
  const auth = checkGhAuth();
  line(auth.ok, auth.ok ? `GitHub CLI authenticated → ${targetRepo()}` : 'GitHub CLI', auth.hint);
  if (auth.ok && releaseExists(tag)) line(false, `release ${tag} already exists`, 'bump the version or delete the existing release');
}

if (failed) die('preflight failed — nothing was built.');
if (dryRun) {
  console.log(`\n(dry run) would ${skipBuild ? 'verify the existing build' : 'build'}${wantPublish ? ` and publish ${tag}` : ''}.`);
  process.exit(0);
}

// ── 2. Build ────────────────────────────────────────────────────
if (!skipBuild) {
  step('Build');
  console.log('  running the full electron:build pipeline…\n');
  const env = { ...process.env };
  const build = spawnSync('pnpm', ['run', 'electron:build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  if (build.status !== 0) die(`build failed (exit ${build.status})`);
} else {
  step('Build — skipped (--skip-build)');
}

// ── 3. Verify ───────────────────────────────────────────────────
step('Verify');
const verification = verifyBuild(root, outputDir);
for (const check of verification.checks) line(check.ok, check.name, check.detail);
if (!verification.ok) die('verification failed — the artifact was NOT published.');

const assets = releaseAssets(outputDir, version);
const installer = assets.find((a) => a.endsWith('.exe'));
if (!installer) die(`installer not found in ${outputDir} for version ${version}`);
const sizeMb = (readFileSync(installer).byteLength / 1024 / 1024).toFixed(0);

console.log(`\n\x1b[1mArtifact\x1b[0m\n  ${installer}\n  ${sizeMb} MB · ${assets.length} asset(s) ready`);

// ── 4. Publish ──────────────────────────────────────────────────
if (!wantPublish) {
  console.log('\nNot published (pass --publish to create the GitHub Release).');
  process.exit(0);
}

step(`Publish → ${targetRepo()}`);
for (const asset of assets) console.log(`  · ${path.basename(asset)}`);

const approved = has('--yes') || (await confirm(`\nCreate release ${tag} on ${targetRepo()}?`));
if (!approved) {
  console.log('Aborted — nothing was published.');
  process.exit(process.stdin.isTTY ? 0 : 1);
}

const url = publishRelease({
  tag,
  title: `CodeStudio Local ${version}`,
  notes: value('--notes'),
  assets,
  draft: has('--draft'),
  prerelease: has('--prerelease'),
});
console.log(`\n\x1b[32m✓ Published ${tag}\x1b[0m\n  ${url}`);
