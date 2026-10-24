import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Execution attempts are derived from durable delta fences. Keep the newest
// attempt per namespace/generation; never remove a delta, fence or queued job.
export const redundantAttemptSql = `
  WITH attempts AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY namespace, generation_id, kind ORDER BY id DESC
    ) AS position
    FROM semantic_jobs
    WHERE status = 'paused' AND kind = 'build' AND generation_id IS NOT NULL
      AND (namespace = 'memory:user' OR namespace GLOB 'memory:project:p[0-9]*'
        OR namespace GLOB 'snapshot:p[0-9]*')
      AND COALESCE(json_extract(cursor, '$.reason'), '') <> 'mutation-fence'
  ) SELECT id FROM attempts WHERE position > 1`;

function counts(db) {
  return db.prepare('SELECT status, COUNT(*) AS jobs FROM semantic_jobs GROUP BY status ORDER BY status').all();
}

function protectedDigest(db) {
  const hash = createHash('sha256');
  for (const row of db.prepare(`SELECT * FROM semantic_jobs WHERE id NOT IN (${redundantAttemptSql}) ORDER BY id`).iterate()) {
    hash.update(JSON.stringify(row));
  }
  for (const row of db.prepare('SELECT * FROM semantic_namespace_generations ORDER BY namespace').iterate()) {
    hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

export async function cleanupSemanticQueue({ dbPath, apply = false, backupDir }) {
  const db = new Database(resolve(dbPath), { readonly: !apply, fileMustExist: true, timeout: 1000 });
  try {
    const before = counts(db);
    const candidates = db.prepare(`SELECT COUNT(*) AS n FROM (${redundantAttemptSql})`).get().n;
    if (!apply || candidates === 0) return { applied: false, candidates, before };
    if (!backupDir) throw new Error('An explicit backup directory is required with --apply');
    if (before.some((row) => row.status === 'running' && row.jobs > 0)) {
      throw new Error('Running semantic jobs exist; stop the owning app before maintenance');
    }
    const output = resolve(backupDir);
    mkdirSync(output, { recursive: true });
    const backupPath = join(output, 'index-before-cleanup.db');
    if (existsSync(backupPath)) throw new Error('Backup already exists; choose a new backup directory');
    const dataVersion = db.pragma('data_version', { simple: true });
    await db.backup(backupPath);
    // SQLite extensions must be available for a meaningful integrity check.
    require('sqlite-vec').load(db);
    const result = db.transaction(() => {
      if (db.pragma('data_version', { simple: true }) !== dataVersion) {
        throw new Error('The database changed during backup; no rows removed. Retry with the app idle');
      }
      const digest = protectedDigest(db);
      const removed = db.prepare(`DELETE FROM semantic_jobs WHERE id IN (${redundantAttemptSql})`).run().changes;
      if (removed !== candidates || protectedDigest(db) !== digest) {
        throw new Error('Maintenance verification failed; rolling back');
      }
      const integrity = db.pragma('quick_check');
      if (integrity.some((row) => Object.values(row)[0] !== 'ok')) {
        throw new Error('SQLite integrity verification failed; rolling back');
      }
      return { applied: true, removed, before, after: counts(db), backupPath, integrity: 'ok' };
    }).immediate();
    writeFileSync(join(output, 'cleanup-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const dbPath = option('--db');
  if (!dbPath) throw new Error('Usage: cleanup-semantic-queue.mjs --db <index.db> [--apply --backup-dir <new-directory>]');
  cleanupSemanticQueue({ dbPath, apply: args.includes('--apply'), backupDir: option('--backup-dir') })
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
