import type { Command } from 'commander';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { backfillSnapshotEmbeddings } from '@mcp/services/services/snapshot-backfill.js';
import { createAndSeedProviderStore, createSearchBundle } from '@mcp/indexer/bootstrap/index.js';
import { createReranker } from '@mcp/indexer/search/reranker.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { getDB } from '../helpers.js';
import type { SnapshotCategory } from '@mcp/shared/types.js';

export function register(program: Command): void {
  const snapshots = program.command('snapshots').description('Manage context snapshots');

  snapshots.command('list <project>').option('-c, --category <cat>', 'Filter by category').action((projectName: string, opts: { category?: string }) => {
    const db = getDB();
    const svc = new SnapshotService(db);
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const list = svc.list(project.id, opts.category as SnapshotCategory | undefined);
    for (const s of list) { console.log(`  #${s.id} [${s.category}] ${s.title} (${s.created_by})`); }
    db.close();
  });

  snapshots.command('add <project>').requiredOption('-t, --title <title>', 'Title').requiredOption('-c, --category <cat>', 'Category').requiredOption('--content <text>', 'Content')
    .action(async (projectName: string, opts: { title: string; category: string; content: string }) => {
      const db = getDB();
      const svc = new SnapshotService(db);
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }
      const { snap, embedError } = await svc.create(project.id, { title: opts.title, category: opts.category as SnapshotCategory, content: opts.content });
      console.log(`Snapshot #${snap.id} created.${embedError ? ` (warning: vector index not updated — ${embedError})` : ''}`);
      db.close();
    });

  snapshots.command('edit <id>').option('-t, --title <title>').option('-c, --category <cat>').option('--content <text>')
    .action(async (id: string, opts: { title?: string; category?: string; content?: string }) => {
      const db = getDB();
      const svc = new SnapshotService(db);
      const { embedError } = await svc.update(parseInt(id, 10), { title: opts.title, category: opts.category as SnapshotCategory | undefined, content: opts.content });
      console.log(`Snapshot #${id} updated.${embedError ? ` (warning: vector index not updated — ${embedError})` : ''}`);
      db.close();
    });

  snapshots.command('remove <id>').action((id: string) => {
    const db = getDB();
    const svc = new SnapshotService(db);
    svc.delete(parseInt(id, 10));
    console.log(`Snapshot #${id} deleted.`);
    db.close();
  });

  snapshots
    .command('backfill <project>')
    .description('Embed any snapshots that are missing a vector index (idempotent — already-embedded rows short-circuit on hash).')
    .action(async (projectName: string) => {
      const db = getDB();
      const project = db.getProjectByName(projectName);
      if (!project) {
        console.error('Project not found');
        db.close();
        process.exit(1);
      }
      const config = loadConfig();
      const providerStore = createAndSeedProviderStore(config.dbPath);
      const { embeddingService, searchableVectorStore } = createSearchBundle(
        db,
        providerStore,
        createReranker(),
      );
      const svc = new SnapshotService(db, embeddingService, searchableVectorStore);
      if (!svc.hasEmbeddingBackend()) {
        console.error('No embedding/vector backend configured. Configure one in the dashboard or via env first.');
        db.close();
        process.exit(1);
      }
      console.log(`Backfilling snapshot embeddings for "${projectName}"...`);
      const result = await backfillSnapshotEmbeddings(db, svc, project.id);
      console.log(
        `embedded=${result.embedded} failed=${result.failed} skipped=${result.skipped}` +
        (result.errors.length > 0 ? `\nfirst errors: ${result.errors.join(' | ')}` : ''),
      );
      db.close();
    });

  program.command('context <project>').description('Show project context').action((projectName: string) => {
    const db = getDB();
    const svc = new SnapshotService(db);
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    console.log(svc.getForContext(project.id));
    db.close();
  });
}
