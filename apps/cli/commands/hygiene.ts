import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import {
  SemanticStore,
  semanticPurposeForNamespace,
  type SemanticPurpose,
} from '@mcp/store/semantic-store.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import {
  queueSemanticReindex,
  requestLocalServer,
  requestProjectRemoval,
} from '../semantic-control.js';

/**
 * CLI mirror of /api/hygiene/*. Same operations, same DB methods —
 * useful for cron jobs, scripted cleanup after a failed deploy, or
 * environments without the dashboard running.
 */
export function register(program: Command): void {
  const hygiene = program.command('hygiene').description('Local semantic index hygiene');

  hygiene
    .command('status')
    .description('Show structural and semantic generation health by project')
    .action(() => {
      const db = new CodeIndexDB(loadConfig().dbPath);
      try {
        const projects = db.listProjects();
        const semanticStore = new SemanticStore(db.raw());

        console.log(
          `${'Project'.padEnd(28)} ${'Files'.padStart(6)} ${'Structural'.padEnd(12)} ${'Semantic'.padEnd(10)} ${'Coverage'.padEnd(15)} ${'Delta'.padStart(6)} ${'Fail'.padStart(5)} disk`,
        );
        console.log('-'.repeat(110));
        for (const p of projects) {
          const stats = db.getStats(p.id);
          const state = semanticStore.listNamespaceGenerations({ namespace: codeNamespace(p.id) })[0];
          const semantic = state?.active_generation_id
            ? state.delta_items > 0 ? 'updating' : 'active'
            : state?.building_generation_id ? 'building' : 'none';
          const coverage = `${state?.indexed_items ?? 0}/${state?.expected_items ?? 0}`;
          const diskMissing = !existsSync(p.root_path);
          console.log(
            `${p.name.slice(0, 28).padEnd(28)} ${String(stats.file_count).padStart(6)} ${(p.structural_indexed_at ? 'ready' : 'missing').padEnd(12)} ${semantic.padEnd(10)} ${coverage.padEnd(15)} ${String(state?.delta_items ?? 0).padStart(6)} ${String(state?.failed_items ?? 0).padStart(5)} ${diskMissing ? 'MISSING' : 'ok'}`,
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
      try {
        const project = db.getProjectByName(projectName);
        if (!project) {
          console.error(`Project "${projectName}" not found.`);
          process.exit(1);
        }

        const server = await requestLocalServer(
          `/api/hygiene/projects/${project.id}/cleanup`,
          { method: 'POST' },
        );
        if (server.ok) {
          const result = server.body as {
            orphan_semantic_items?: number;
            vectors_deleted_local?: number;
            local_deleted?: number;
            languages_normalized?: number;
            stale_runs_closed?: number;
            vector_error?: string | null;
          };
          console.log(`Cleanup for "${project.name}":`);
          console.log(`  orphan semantic items: ${result.orphan_semantic_items ?? 0} (vectors: ${result.vectors_deleted_local ?? 0}, items: ${result.local_deleted ?? 0})`);
          console.log(`  languages normalized: ${result.languages_normalized ?? 0}`);
          console.log(`  stale runs closed: ${result.stale_runs_closed ?? 0}`);
          if (result.vector_error) console.log(`  VECTOR ERROR: ${result.vector_error}`);
          return;
        }

        // Never open the vector database from the CLI as a destructive fallback. Keep
        // the orphan ledger intact, publish deltas and let the worker reconcile
        // exact physical ids once it is available again.
        const orphans = db.getOrphanSemanticItems(project.id);
        const semanticStore = new SemanticStore(db.raw());
        const byNamespace = new Map<string, Set<string>>();
        for (const orphan of orphans) {
          const keys = byNamespace.get(orphan.namespace) ?? new Set<string>();
          keys.add(orphan.item_key);
          byNamespace.set(orphan.namespace, keys);
        }
        const purposes = new Set<SemanticPurpose>();
        for (const [namespace, keys] of byNamespace) {
          semanticStore.noteNamespaceMutation({
            namespace,
            itemKeys: [...keys],
            operation: 'delete',
          });
          purposes.add(semanticPurposeForNamespace(namespace));
        }
        for (const purpose of purposes) await queueSemanticReindex(db, purpose);
        const langs = db.normalizeFileLanguages(project.id);
        const stale = db.markStaleRuns(2, project.id);

        console.log(`Cleanup for "${project.name}":`);
        console.log(`  orphan vectors: ${orphans.length} (semantic cleanup scheduled; no CLI unlink)`);
        console.log(`  languages normalized: ${langs}`);
        console.log(`  stale runs closed: ${stale}`);
        console.log(`  worker: ${server.error ?? 'local server unavailable'}`);
      } finally {
        db.close();
      }
    });

  hygiene
    .command('purge-missing')
    .description('Safely schedule deletion of projects whose root_path no longer exists')
    .option('--confirm', 'Required — destructive operation')
    .action(async (opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        console.error('Refusing to run without --confirm.');
        process.exit(1);
      }
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);
      try {
        const projects = db.listProjects().filter((p) => !existsSync(p.root_path));
        if (projects.length === 0) {
          console.log('No missing projects.');
          return;
        }
        for (const project of projects) {
          const removal = await requestProjectRemoval(db, project.id);
          if (removal.completed) {
            console.log(`Purged "${project.name}" — semantic namespace removal completed by the worker.`);
          } else {
            console.log(
              `Removal of "${project.name}" scheduled as job #${removal.marker.id}; `
              + 'its semantic namespace remains fenced until the server-owned worker drains it safely.',
            );
          }
        }
      } finally {
        db.close();
      }
    });

  hygiene
    .command('sql-sweep')
    .description('Run global SQL-only cleanup (normalize languages and close stale runs)')
    .action(() => {
      const db = new CodeIndexDB(loadConfig().dbPath);
      try {
        const langs = db.normalizeFileLanguages();
        const stale = db.markStaleRuns(2);
        console.log(`Languages normalized: ${langs}`);
        console.log(`Stale runs closed: ${stale}`);
      } finally {
        db.close();
      }
    });
}
