/**
 * Virtual union workspace for GLOBAL (multi-project) sessions.
 *
 * A global session runs as a NORMAL session over a SYNTHETIC project whose
 * root is a directory of directory-junctions (Windows) / symlinks (POSIX), one
 * per linked real project:
 *
 *   <dataDir>/global-workspaces/<id>/
 *     ├─ poa-backend/          → junction → D:\poa-monorepo\backend
 *     └─ poa-intranet-angular/ → junction → D:\poa-monorepo\intranet
 *
 * Because the union is a REAL directory, every tool (native fs via the port,
 * `glob` via node:fs, the indexer/grep reading root_path) traverses it
 * uniformly — no primary/secondary, no `mcp__<slug>__*` bridges.
 *
 * SAFETY: `cleanupGlobalWorkspace` removes ONLY the link entries (it never
 * recurses into a junction/symlink, so the real projects' files are never
 * touched). This is enforced with `lstat` + a reparse-point check, and a hard
 * refusal to delete any entry that is not a link.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assignWorkspaceSlugs,
  workspaceSlug,
} from '@mcp/shared/utils/workspace-slug.js';

export interface GlobalWorkspaceLink {
  /** Folder name inside the union dir (== how the agent addresses the project). */
  slug: string;
  /** Absolute real root the link points at. */
  targetPath: string;
}

export { workspaceSlug } from '@mcp/shared/utils/workspace-slug.js';

function isReparsePoint(p: string): boolean {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return true; // POSIX symlink (+ Win file symlink)
    if (st.isDirectory()) {
      // A Windows junction is reported as a directory by lstat; detect it by a
      // realpath that differs from its own path (it redirects elsewhere).
      return resolve(realpathSync(p)).toLowerCase() !== resolve(p).toLowerCase();
    }
  } catch {
    /* missing / unreadable */
  }
  return false;
}

/**
 * Remove ONLY the link entry at `link` — never the target's contents. rmdir on a
 * Windows junction removes the reparse point; unlink removes a POSIX symlink.
 * Trying both (in this order) is safe on every platform and never recurses.
 */
function safeRemoveLink(link: string): boolean {
  try {
    rmdirSync(link); // Windows junction (reparse point) — removes the link only
    return true;
  } catch {
    /* not a junction / POSIX symlink-to-dir → try unlink */
  }
  try {
    unlinkSync(link); // POSIX symlink (+ Windows file symlink)
    return true;
  } catch {
    return false;
  }
}

/** Remove an agent-owned artifact tree without ever traversing a link. */
function safeRemoveOwnedTree(path: string): boolean {
  if (isReparsePoint(path)) return safeRemoveLink(path);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return true;
  }
  if (!st.isDirectory()) {
    try { unlinkSync(path); return true; } catch { return false; }
  }
  let entries: string[];
  try { entries = readdirSync(path); } catch { return false; }
  for (const name of entries) {
    if (!safeRemoveOwnedTree(join(path, name))) return false;
  }
  try { rmdirSync(path); return true; } catch { return false; }
}

function existsByLstat(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function ensureLink(link: string, target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    // A dangling link is invisible to existsSync but still occupies its path.
    // Remove only that reparse point; never create/keep a link to an absent DB
    // target because it would make the workspace look partially empty.
    if (existsByLstat(link) && isReparsePoint(link)) safeRemoveLink(link);
    throw new Error(`linked project target is missing or not a directory: ${target}`);
  }
  if (existsByLstat(link)) {
    // Keep it if it already points at the right target.
    if (isReparsePoint(link)) {
      try {
        if (resolve(realpathSync(link)).toLowerCase() === target.toLowerCase()) return;
      } catch {
        /* fall through to recreate */
      }
      safeRemoveLink(link); // stale/broken link → recreate (never touches target)
    } else {
      throw new Error(`refusing to replace non-link workspace entry: ${link}`);
    }
  }
  // 'junction' ⇒ Windows directory junction (no admin); ignored on POSIX where a
  // normal directory symlink is created instead (no sudo).
  symlinkSync(target, link, 'junction');
}

/**
 * Build (idempotently) the union directory with one link per project. Fail-open
 * per link: a link that can't be created is logged and skipped so the rest still
 * work. Returns the links present after the call. Two projects that slugify to
 * the same name get a numeric suffix so neither is lost.
 */
export function buildGlobalWorkspace(
  dir: string,
  projects: ReadonlyArray<{ name: string; rootPath: string }>,
): GlobalWorkspaceLink[] {
  mkdirSync(dir, { recursive: true });
  const out: GlobalWorkspaceLink[] = [];
  const desired = new Set<string>();
  for (const p of assignWorkspaceSlugs(projects)) {
    const slug = p.slug;
    desired.add(slug);
    const link = join(dir, slug);
    const target = resolve(p.rootPath);
    try {
      ensureLink(link, target);
      out.push({ slug, targetPath: target });
    } catch (e) {
      console.warn(
        `[global-workspace] link ${slug} → ${target} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Reconcile stale project links (renamed/detached projects). Non-link files
  // remain untouched; only reparse points outside the authoritative slug set
  // are removed.
  let existing: string[] = [];
  try { existing = readdirSync(dir); } catch { /* already handled above */ }
  for (const name of existing) {
    if (desired.has(name)) continue;
    const entry = join(dir, name);
    if (name === '.mcp-indexer') safeRemoveOwnedTree(entry);
    else if (isReparsePoint(entry)) safeRemoveLink(entry);
  }
  return out;
}

/**
 * SAFE teardown: remove every LINK inside `dir` (never the targets), then the
 * now-empty `dir`. Any entry that is NOT a link is refused (logged, left intact)
 * — a hard guard against ever deleting real project files.
 */
export function cleanupGlobalWorkspace(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // already gone
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (isReparsePoint(p)) {
      safeRemoveLink(p);
    } else if (name === '.mcp-indexer') {
      // Legacy ToolOutputStore data created inside old synthetic roots. This
      // exact agent-owned folder is safe to prune; the recursive helper checks
      // every level for reparse points before descending.
      safeRemoveOwnedTree(p);
    } else {
      console.warn(`[global-workspace] refusing to remove non-link entry: ${p}`);
    }
  }
  try {
    rmdirSync(dir); // only succeeds if empty (i.e. every entry was a link we removed)
  } catch {
    /* a non-link entry remained, or the dir is gone — leave it */
  }
}
