/**
 * One-time, NON-DESTRUCTIVE migration: copy legacy durable memory that lives in
 * the `snapshots` table into the dedicated `agent_memory` store (migration 181).
 *
 * Why: before migration 181, "project memory" was snapshots with a memory
 * `source` (agent/session/compaction/distill). Those rows keep working as
 * snapshots, but new Agent Memory reads/writes go through `agent_memory`, so we
 * back-fill history once here. Snapshots are NEVER deleted or modified.
 *
 * Predicate (source-first, NOT category): include rows whose `source` is a
 * memory provenance — agent | session | compaction | distill — and EXCLUDE
 * curated/indexed snapshots (`manual`, `index`). Category is informational only.
 *
 * Idempotent: a row is skipped when an `agent_memory` row already carries its
 * `source_snapshot_id`, so re-running (e.g. after an interrupted embed) never
 * duplicates.
 *
 * Embeddings are NOT generated here (keeps the script provider-free and fast):
 * migrated rows are immediately FTS-searchable; their vectors are back-filled by
 * `AgentMemoryService.backfillEmbeddings()` (run once at server boot).
 *
 * Prereq: `pnpm node:rebuild` (better-sqlite3 → Node ABI) OR run via
 * `ELECTRON_RUN_AS_NODE=1 electron node_modules/.bin/tsx`. Run with the app closed.
 *
 * Usage:
 *   tsx scripts/migrate-snapshot-memory-to-agent-memory.ts --dry-run
 *   tsx scripts/migrate-snapshot-memory-to-agent-memory.ts          # real run
 *   tsx scripts/migrate-snapshot-memory-to-agent-memory.ts --db /path/to/index.db
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { AgentMemoryScope, AgentMemoryType } from '@mcp/shared/types.js';

/** Snapshot `category` → closed agent-memory `type` (preference/external map to note/pref). */
const CATEGORY_TO_TYPE: Record<string, AgentMemoryType> = {
  architecture: 'architecture',
  decision: 'decision',
  pattern: 'pattern',
  convention: 'convention',
  procedure: 'procedure',
  gotcha: 'gotcha',
  user: 'preference',
  feedback: 'preference',
  todo: 'note',
  note: 'note',
};

/** Only these snapshot sources are durable MEMORY (the rest are curated/index). */
const MEMORY_SOURCES = new Set(['agent', 'session', 'compaction', 'distill']);

interface SnapRow {
  id: number;
  project_id: number;
  title: string | null;
  category: string | null;
  content: string | null;
  importance: number | null;
  source: string | null;
  scope: string | null;
}

function main(): void {
  const { values } = parseArgs({
    options: { 'dry-run': { type: 'boolean' }, db: { type: 'string' } },
  });
  const dry = values['dry-run'] === true;
  const dbPath = (values.db as string | undefined) ?? loadConfig().dbPath;

  process.stdout.write(`[migrate-mem] ${dry ? 'DRY-RUN' : 'LIVE'} — db=${dbPath}\n`);
  const db = new CodeIndexDB(dbPath);
  try {
    const rows = db
      .raw()
      .prepare(
        `SELECT id, project_id, title, category, content, importance, source, scope
           FROM snapshots WHERE archived_at IS NULL ORDER BY id`,
      )
      .all() as SnapRow[];

    let eligible = 0;
    let created = 0;
    let skippedSource = 0;
    let skippedEmpty = 0;
    let skippedExisting = 0;
    let errors = 0;

    for (const s of rows) {
      // User-scope MANUAL rows are preferences typed in the old UI (which
      // wrote to snapshots while the injector reads agent_memory) — carry
      // them over. Project-scope manual/index snapshots stay excluded.
      const isManualUserPref = s.source === 'manual' && (s.scope === 'user' || s.project_id === 0);
      if (!isManualUserPref && (!s.source || !MEMORY_SOURCES.has(s.source))) {
        skippedSource++;
        continue;
      }
      eligible++;
      const title = s.title?.trim();
      const content = s.content?.trim();
      if (!title || !content) {
        skippedEmpty++;
        continue;
      }
      if (db.findAgentMemoryBySourceSnapshot(s.id)) {
        skippedExisting++;
        continue;
      }
      const scope: AgentMemoryScope = s.scope === 'user' || s.project_id === 0 ? 'user' : 'project';
      const type = CATEGORY_TO_TYPE[s.category ?? 'note'] ?? 'note';
      if (dry) {
        created++;
        continue;
      }
      try {
        db.createAgentMemory({
          scope,
          projectId: s.project_id,
          name: title,
          type,
          content,
          source: 'migrated-snapshot',
          sourceSnapshotId: s.id,
          importance: s.importance ?? 0.5,
        });
        created++;
      } catch (e) {
        errors++;
        process.stderr.write(
          `[migrate-mem] snapshot ${s.id} failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    process.stdout.write(
      `[migrate-mem] done — total=${rows.length} eligible=${eligible} ` +
        `${dry ? 'would-create' : 'created'}=${created} ` +
        `skipped(non-memory-source)=${skippedSource} skipped(empty)=${skippedEmpty} ` +
        `skipped(already-migrated)=${skippedExisting} errors=${errors}\n`,
    );
    if (dry) {
      process.stdout.write('[migrate-mem] DRY-RUN — no rows written, no snapshots touched.\n');
    } else {
      process.stdout.write(
        '[migrate-mem] snapshots left intact. Vectors back-fill at next server boot ' +
          '(AgentMemoryService.backfillEmbeddings); FTS recall works immediately.\n',
      );
    }
  } finally {
    db.close();
  }
}

main();
