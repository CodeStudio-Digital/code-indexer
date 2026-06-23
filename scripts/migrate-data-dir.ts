#!/usr/bin/env tsx
/**
 * One-shot migration: relocate the legacy project-root `data/` tree into
 * the canonical user data dir (`mcpDataDir()` → `~/.mcp-code-indexer`)
 * and rewrite the absolute paths the DB persisted under the old location.
 *
 * Run with the app STOPPED:
 *   pnpm node:rebuild && pnpm migrate:data-dir   # then `pnpm electron:rebuild`
 *   pnpm migrate:data-dir --dry-run              # preview, change nothing
 *
 * Idempotent: re-running after a partial move only moves what's left and
 * only rewrites rows still pointing at the old base. Folders that hold
 * DB-referenced absolute paths (virtual-projects, design-system-uploads,
 * design-system-mcp) get their rows rewritten; packages/ and sandboxes/
 * are recomputed by the app, so a plain move suffices.
 *
 * `mcp.db` and `external/` are reported but NOT deleted — they have no
 * code references (stale leftovers); the operator removes them by hand.
 */
import Database from 'better-sqlite3';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, mcpDataDir } from '@mcp/shared/utils/config.js';
import {
  designSystemMcpDir,
  designSystemUploadsDir,
  sandboxArchiveDir,
  verdaccioStorageDir,
  virtualProjectsBaseDir,
} from '@mcp/shared/utils/data-paths.js';

type DB = Database.Database;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD_DATA = join(repoRoot, 'data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const DRY = process.argv.includes('--dry-run');

function log(msg: string): void {
  console.log(`[migrate-data-dir]${DRY ? ' (dry-run)' : ''} ${msg}`);
}

/** Replace `oldBase` prefix in an absolute path, or return null if not under it. */
function rewritePrefix(value: string, oldBase: string, newBase: string): string | null {
  if (value === oldBase) return newBase;
  if (value.startsWith(oldBase + '\\') || value.startsWith(oldBase + '/')) {
    return newBase + value.slice(oldBase.length);
  }
  return null;
}

/** Move a directory tree cross-volume-safe (D:→C: makes rename() throw EXDEV). */
function moveTree(from: string, to: string): void {
  if (!existsSync(from)) {
    log(`skip move (absent): ${from}`);
    return;
  }
  if (from === to) {
    log(`skip move (already in place): ${from}`);
    return;
  }
  if (DRY) {
    log(`would move ${from} → ${to} (${readdirSync(from).length} entries)`);
    return;
  }
  mkdirSync(to, { recursive: true });
  // force:false keeps anything already present at the destination.
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  rmSync(from, { recursive: true, force: true });
  log(`moved ${from} → ${to}`);
}

function backupDb(dbPath: string): void {
  if (DRY) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (existsSync(f)) copyFileSync(f, `${f}.bak.${stamp}`);
  }
  log(`backed up DB (+ -wal/-shm) → *.bak.${stamp}`);
}

interface Row {
  id: number | string;
  val: string;
}

function rewriteColumn(
  db: DB,
  table: string,
  col: string,
  oldBase: string,
  newBase: string,
): number {
  const rows = db
    .prepare(`SELECT id AS id, ${col} AS val FROM ${table} WHERE ${col} IS NOT NULL`)
    .all() as Row[];
  const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
  let count = 0;
  for (const row of rows) {
    const next = rewritePrefix(row.val, oldBase, newBase);
    if (next !== null && next !== row.val) {
      if (!DRY) upd.run(next, row.id);
      count++;
    }
  }
  return count;
}

/** Rewrite path prefixes inside a JSON-array text column (e.g. mcp args). */
function rewriteJsonArrayColumn(
  db: DB,
  table: string,
  col: string,
  oldBase: string,
  newBase: string,
): number {
  const rows = db
    .prepare(`SELECT id AS id, ${col} AS val FROM ${table} WHERE ${col} IS NOT NULL`)
    .all() as Row[];
  const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
  let count = 0;
  for (const row of rows) {
    let arr: unknown;
    try {
      arr = JSON.parse(row.val);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    let changed = false;
    const next = arr.map((el) => {
      if (typeof el !== 'string') return el;
      const r = rewritePrefix(el, oldBase, newBase);
      if (r !== null && r !== el) {
        changed = true;
        return r;
      }
      return el;
    });
    if (changed) {
      if (!DRY) upd.run(JSON.stringify(next), row.id);
      count++;
    }
  }
  return count;
}

function rewriteDbPaths(dbPath: string): void {
  if (!existsSync(dbPath)) {
    log(`no DB at ${dbPath} — skipping path rewrites`);
    return;
  }
  const db = new Database(dbPath, { readonly: DRY });
  try {
    const run = () => {
      const p = rewriteColumn(
        db, 'projects', 'root_path',
        join(OLD_DATA, 'virtual-projects'), virtualProjectsBaseDir(),
      );
      log(`projects.root_path: ${p} row(s) ${DRY ? 'would be ' : ''}rewritten`);

      const u = rewriteColumn(
        db, 'design_system_sessions', 'source_zip_path',
        join(OLD_DATA, 'design-system-uploads'), designSystemUploadsDir(),
      );
      log(`design_system_sessions.source_zip_path: ${u} row(s) ${DRY ? 'would be ' : ''}rewritten`);

      const m = rewriteJsonArrayColumn(
        db, 'mcp_server_configs', 'args',
        join(OLD_DATA, 'design-system-mcp'), designSystemMcpDir(),
      );
      log(`mcp_server_configs.args: ${m} row(s) ${DRY ? 'would be ' : ''}rewritten`);
    };
    if (DRY) run();
    else db.transaction(run)();
  } finally {
    db.close();
  }
}

function reportLeftovers(): void {
  if (!existsSync(OLD_DATA)) return;
  const left = readdirSync(OLD_DATA);
  if (left.length === 0) {
    log(`data/ is now empty — safe to delete: ${OLD_DATA}`);
    return;
  }
  log(`remaining in data/ (NOT deleted — review & remove manually):`);
  for (const name of left) log(`  - ${join(OLD_DATA, name)}`);
}

function main(): void {
  log(`old data dir: ${OLD_DATA}`);
  log(`new data dir: ${mcpDataDir()}`);
  if (!existsSync(OLD_DATA)) {
    log('nothing to migrate — data/ does not exist.');
    return;
  }

  const dbPath = loadConfig().dbPath;
  backupDb(dbPath);

  moveTree(join(OLD_DATA, 'virtual-projects'), virtualProjectsBaseDir());
  moveTree(join(OLD_DATA, 'packages'), verdaccioStorageDir());
  moveTree(join(OLD_DATA, 'sandboxes'), sandboxArchiveDir());
  moveTree(join(OLD_DATA, 'design-system-uploads'), designSystemUploadsDir());
  moveTree(join(OLD_DATA, 'design-system-mcp'), designSystemMcpDir());

  rewriteDbPaths(dbPath);
  reportLeftovers();
  log('done.');
}

main();
