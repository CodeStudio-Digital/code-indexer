import type { Command } from 'commander';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { getDB } from '../helpers.js';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import { snapshotNamespace } from '@mcp/shared/vector-namespace.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import {
  createCliSemanticMutationSink,
} from '../semantic-control.js';

function reconciliationNotice(db: ReturnType<typeof getDB>): string {
  const enabled = new SemanticStore(db.raw()).getProfile('memory')?.embedding_target.kind !== 'disabled';
  return enabled ? ' Semantic reconciliation was queued for this project only.' : '';
}

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
      try {
        const svc = new SnapshotService(db, null, null, createCliSemanticMutationSink(db));
        const project = db.getProjectByName(projectName);
        if (!project) { console.error('Project not found'); process.exitCode = 1; return; }
        const { snap } = await svc.create(project.id, {
          title: opts.title,
          category: opts.category as SnapshotCategory,
          content: opts.content,
        });
        console.log(`Snapshot #${snap.id} created.${reconciliationNotice(db)}`);
      } finally {
        db.close();
      }
    });

  snapshots.command('edit <id>').option('-t, --title <title>').option('-c, --category <cat>').option('--content <text>')
    .action(async (id: string, opts: { title?: string; category?: string; content?: string }) => {
      const db = getDB();
      try {
        const svc = new SnapshotService(db, null, null, createCliSemanticMutationSink(db));
        await svc.update(parseInt(id, 10), {
          title: opts.title,
          category: opts.category as SnapshotCategory | undefined,
          content: opts.content,
        });
        const semanticChange = opts.title !== undefined || opts.content !== undefined;
        console.log(`Snapshot #${id} updated.${semanticChange ? reconciliationNotice(db) : ''}`);
      } finally {
        db.close();
      }
    });

  snapshots.command('remove <id>').action(async (id: string) => {
    const db = getDB();
    try {
      const svc = new SnapshotService(db, null, null, createCliSemanticMutationSink(db));
      const numericId = parseInt(id, 10);
      const existing = db.getSnapshotById(numericId);
      svc.delete(numericId);
      console.log(`Snapshot #${id} deleted.${existing ? reconciliationNotice(db) : ''}`);
    } finally {
      db.close();
    }
  });

  snapshots
    .command('backfill <project>')
    .description('Schedule idempotent snapshot reconciliation in the server-owned semantic worker.')
    .action(async (projectName: string) => {
      const db = getDB();
      try {
        const project = db.getProjectByName(projectName);
        if (!project) {
          console.error('Project not found');
          process.exitCode = 1;
          return;
        }
        createCliSemanticMutationSink(db).noteMutation({
          namespace: snapshotNamespace(project.id),
          itemKeys: ['*'],
          operation: 'upsert',
        });
        const enabled = new SemanticStore(db.raw())
          .getProfile('memory')?.embedding_target.kind !== 'disabled';
        if (!enabled) {
          console.log('Memory semantic indexing is disabled; snapshots remain available through SQLite/FTS.');
        } else {
          console.log(`Snapshot reconciliation for "${projectName}" was queued for its namespace only.`);
        }
      } finally {
        db.close();
      }
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
