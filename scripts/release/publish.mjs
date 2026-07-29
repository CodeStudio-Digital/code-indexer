/**
 * GitHub Release publishing.
 *
 * Uses `gh` rather than electron-builder's own publisher for one reason: the
 * builder uploads DURING packaging, so nothing could be verified first. Here
 * publishing is a separate, final step that only runs on a verified artifact.
 *
 * The three assets are exactly what electron-updater needs on Windows:
 * the installer, `latest.yml` (the update feed) and the `.blockmap`
 * (differential download). Publishing the installer alone silently breaks
 * auto-update for every existing user.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

function gh(args, options = {}) {
  return spawnSync('gh', args, { shell: true, encoding: 'utf8', ...options });
}

/** Assets electron-updater needs, in the order they should be uploaded. */
export function releaseAssets(outputDir, version) {
  const installer = path.join(outputDir, `CodeStudio Setup ${version}.exe`);
  return [installer, `${installer}.blockmap`, path.join(outputDir, 'latest.yml')].filter((f) =>
    existsSync(f),
  );
}

export function releaseExists(tag) {
  return gh(['release', 'view', tag, '--json', 'tagName']).status === 0;
}

/**
 * Interactive gate. Publishing is public and effectively irreversible (a
 * deleted release still leaves the tag, and update clients may already have
 * fetched the feed), so it never happens implicitly. `--yes` is honoured for
 * non-interactive use; without a TTY and without it, we refuse.
 */
export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export function publishRelease({ tag, title, notes, assets, draft, prerelease }) {
  const args = ['release', 'create', tag, ...assets.map((a) => `"${a}"`), '--title', `"${title}"`];
  if (notes) args.push('--notes', `"${notes.replace(/"/g, "'")}"`);
  else args.push('--generate-notes');
  if (draft) args.push('--draft');
  if (prerelease) args.push('--prerelease');

  const result = gh(args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`gh release create failed (exit ${result.status})`);
  }
  const view = gh(['release', 'view', tag, '--json', 'url', '-q', '.url']);
  return (view.stdout || '').trim();
}

/** Which repository the release would land in — shown before confirming. */
export function targetRepo() {
  const r = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return (r.stdout || '').trim() || '(unknown)';
}
