import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../../utils/config.js';
import { CodeIndexDB } from '../../../store/db.js';
import { getVectorStore } from '../helpers.js';

/**
 * CLI mirror of /api/hygiene/*. Same operations, same DB methods —
 * useful for cron jobs, scripted cleanup after a failed deploy, or
 * environments without the dashboard running.
 */
export function register(program: Command): void {
  const hygiene = program.command('hygiene').description('Index hygiene + Cloudflare cleanup');

  hygiene
    .command('status')
    .description('Show per-project health counters')
    .action(() => {
      const db = new CodeIndexDB(loadConfig().dbPath);
      try {
        const projects = db.getProjectsHygiene();
        const tiers = db.getProjectTierBreakdown();
        const tiersByProject = new Map<number, Record<string, number>>();
        for (const r of tiers) {
          const bucket = tiersByProject.get(r.project_id) ?? {};
          bucket[r.tier] = r.count;
          tiersByProject.set(r.project_id, bucket);
        }

        const pending = db.countPendingVectorDeletes();
        console.log(`Pending vector deletes: ${pending}`);
        console.log('');
        console.log(
          `${'Project'.padEnd(28)} ${'Files'.padStart(6)} ${'Vec'.padStart(6)} ${'Orph'.padStart(5)} ${'Dup'.padStart(5)} ${'Stale'.padStart(5)} ${'Tiers (c/s/o/u)'.padEnd(20)} disk`,
        );
        console.log('-'.repeat(105));
        for (const p of projects) {
          const t = tiersByProject.get(p.id) ?? {};
          const tierStr = `${t.core ?? 0}/${t.support ?? 0}/${t.on_demand ?? 0}/${t.untagged ?? 0}`;
          const diskMissing = !existsSync(p.root_path);
          console.log(
            `${p.name.slice(0, 28).padEnd(28)} ${String(p.file_count).padStart(6)} ${String(p.vector_count).padStart(6)} ${String(p.orphan_vector_ids).padStart(5)} ${String(p.duplicate_vector_ids).padStart(5)} ${String(p.stale_runs).padStart(5)} ${tierStr.padEnd(20)} ${diskMissing ? 'MISSING' : 'ok'}`,
          );
        }
      } finally {
        db.close();
      }
    });

  hygiene
    .command('cleanup <project>')
    .description('Run full per-project cleanup (orphans + dedup + langs + stale runs)')
    .action(async (projectName: string) => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      const vectorStore = getVectorStore(config.dbPath);
      try {
        const project = db.getProjectByName(projectName);
        if (!project) {
          console.error(`Project "${projectName}" not found.`);
          process.exit(1);
        }

        const orphans = db.getOrphanVectorIds(project.id);
        let remoteDeleted = 0;
        let remoteError: string | null = null;
        if (orphans.length > 0 && vectorStore) {
          try {
            remoteDeleted = await vectorStore.deleteByIds(orphans.map((o) => o.vector_id));
          } catch (err) {
            remoteError = (err as Error).message;
            db.enqueuePendingVectorDeletes(
              orphans.map((o) => ({
                vector_id: o.vector_id,
                project_name: project.name,
                error: remoteError,
              })),
            );
          }
        }
        const localDeleted = db.deleteVectorIdRows(project.id, orphans.map((o) => o.vector_id));
        const dedup = db.dedupVectorIds(project.id);
        const langs = db.normalizeFileLanguages(project.id);
        const stale = db.markStaleRuns(2, project.id);
        if (!remoteError) db.setProjectPendingVectorGc(project.id, false);

        console.log(`Cleanup for "${project.name}":`);
        console.log(`  orphan vectors: ${orphans.length} (remote: ${remoteDeleted}, local: ${localDeleted})`);
        console.log(`  duplicates removed: ${dedup}`);
        console.log(`  languages normalized: ${langs}`);
        console.log(`  stale runs closed: ${stale}`);
        if (remoteError) console.log(`  REMOTE ERROR: ${remoteError}`);
      } finally {
        db.close();
      }
    });

  hygiene
    .command('vectorize-retry')
    .description('Drain the pending_vector_deletes retry queue against the configured vector store')
    .action(async () => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      const vectorStore = getVectorStore(config.dbPath);
      try {
        const batch = db.takePendingVectorDeletes(5000);
        if (batch.length === 0) {
          console.log('Queue empty.');
          return;
        }
        if (!vectorStore) {
          console.error('No vector store configured.');
          process.exit(1);
        }
        try {
          const deleted = await vectorStore.deleteByIds(batch.map((r) => r.vector_id));
          db.deletePendingVectorDeletesByIds(batch.map((r) => r.id));
          console.log(`Drained ${batch.length} ids; remote deleted ${deleted}; remaining ${db.countPendingVectorDeletes()}.`);
        } catch (err) {
          const msg = (err as Error).message;
          db.enqueuePendingVectorDeletes(
            batch.map((r) => ({ vector_id: r.vector_id, project_name: r.project_name, error: msg })),
          );
          console.error(`Retry failed: ${msg}`);
          process.exit(2);
        }
      } finally {
        db.close();
      }
    });

  hygiene
    .command('purge-missing')
    .description('Delete projects whose root_path no longer exists on disk (cascades to Vectorize)')
    .option('--confirm', 'Required — destructive operation')
    .action(async (opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        console.error('Refusing to run without --confirm.');
        process.exit(1);
      }
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      const vectorStore = getVectorStore(config.dbPath);
      try {
        const projects = db.listProjects().filter((p) => !existsSync(p.root_path));
        if (projects.length === 0) {
          console.log('No missing projects.');
          return;
        }
        for (const project of projects) {
          const ids = db.snapshotVectorIdsForProject(project.id);
          let remoteDeleted = 0;
          let remoteError: string | null = null;
          if (ids.length > 0 && vectorStore) {
            try {
              remoteDeleted = await vectorStore.deleteByIds(ids);
            } catch (err) {
              remoteError = (err as Error).message;
              db.enqueuePendingVectorDeletes(
                ids.map((vid) => ({ vector_id: vid, project_name: project.name, error: remoteError })),
              );
            }
          }
          db.deleteProject(project.id);
          console.log(
            `Purged "${project.name}" — ${ids.length} vectors known, remote deleted ${remoteDeleted}${remoteError ? `, ERROR: ${remoteError}` : ''}.`,
          );
        }
      } finally {
        db.close();
      }
    });

  hygiene
    .command('sql-sweep')
    .description('Run global SQL-only cleanup (dedup, normalize languages, close stale runs)')
    .action(() => {
      const db = new CodeIndexDB(loadConfig().dbPath);
      try {
        const dedup = db.dedupVectorIds();
        const langs = db.normalizeFileLanguages();
        const stale = db.markStaleRuns(2);
        console.log(`Duplicates removed: ${dedup}`);
        console.log(`Languages normalized: ${langs}`);
        console.log(`Stale runs closed: ${stale}`);
      } finally {
        db.close();
      }
    });
}
