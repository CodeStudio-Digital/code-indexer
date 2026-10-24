import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

// Local evidence only. No credentials, Git configuration or file contents are
// printed. Keep the archive private: a working-tree patch may contain code/data.
const root = resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(root, 'scratch', 'harness-candidates', stamp);
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args],
  { cwd: root, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = (base, path) => {
  const result = resolve(base, path);
  const rel = relative(base, result);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error('Candidate path escapes its archive');
  }
  return result;
};

const head = git('rev-parse', 'HEAD').toString('utf8').trim();
const status = git('status', '--porcelain=v1', '-z');
const patch = git('diff', '--binary', '--no-ext-diff', 'HEAD');
const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean);
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, 'tracked.patch'), patch);
await writeFile(resolve(destination, 'status.bin'), status);
const files = [];
for (const path of untracked) {
  const source = safePath(root, path);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsupported untracked entry: ${path}`);
  const target = safePath(resolve(destination, 'untracked'), path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  const bytes = await readFile(target);
  files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}
// Refuse a capture taken across concurrent tracked edits instead of attesting
// to a patch that no longer describes the current candidate.
if (!patch.equals(git('diff', '--binary', '--no-ext-diff', 'HEAD'))
    || !status.equals(git('status', '--porcelain=v1', '-z'))) {
  throw new Error(`Checkout changed while capturing candidate; archive is incomplete: ${destination}`);
}
const manifest = { schemaVersion: 1, capturedAt: new Date().toISOString(), head,
  node: process.version, platform: process.platform, arch: process.arch,
  trackedPatchSha256: sha256(patch), statusSha256: sha256(status), untracked: files,
  restore: 'Apply tracked.patch to HEAD in an isolated checkout, then copy untracked/ without overwriting unrelated files.' };
const encoded = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(resolve(destination, 'manifest.json'), encoded);
console.log(JSON.stringify({ destination, head, untrackedFiles: files.length, manifestSha256: sha256(encoded) }));
