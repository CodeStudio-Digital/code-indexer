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
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface GlobalWorkspaceLink {
  /** Folder name inside the union dir (== how the agent addresses the project). */
  slug: string;
  /** Absolute real root the link points at. */
  targetPath: string;
}

/** Deterministic, filesystem-safe folder name for a project. */
export function workspaceSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'project';
}

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

function ensureLink(link: string, target: string): void {
  if (existsSync(link)) {
    // Keep it if it already points at the right target.
    if (isReparsePoint(link)) {
      try {
        if (resolve(realpathSync(link)).toLowerCase() === target.toLowerCase()) return;
      } catch {
        /* fall through to recreate */
      }
    }
    safeRemoveLink(link); // stale link → recreate (never touches a real dir target)
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
  const used = new Set<string>();
  for (const p of projects) {
    const base = workspaceSlug(p.name);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}_${n++}`;
    used.add(slug);
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
