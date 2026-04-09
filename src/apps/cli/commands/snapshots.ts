import type { Command } from 'commander';
import { SnapshotService } from '../../../core/services/snapshots.js';
import { getDB } from '../helpers.js';
import type { SnapshotCategory } from '../../../types.js';

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
    .action((projectName: string, opts: { title: string; category: string; content: string }) => {
      const db = getDB();
      const svc = new SnapshotService(db);
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }
      const snap = svc.create(project.id, { title: opts.title, category: opts.category as SnapshotCategory, content: opts.content });
      console.log(`Snapshot #${snap.id} created.`);
      db.close();
    });

  snapshots.command('edit <id>').option('-t, --title <title>').option('-c, --category <cat>').option('--content <text>')
    .action((id: string, opts: { title?: string; category?: string; content?: string }) => {
      const db = getDB();
      const svc = new SnapshotService(db);
      svc.update(parseInt(id, 10), { title: opts.title, category: opts.category as SnapshotCategory | undefined, content: opts.content });
      console.log(`Snapshot #${id} updated.`);
      db.close();
    });

  snapshots.command('remove <id>').action((id: string) => {
    const db = getDB();
    const svc = new SnapshotService(db);
    svc.delete(parseInt(id, 10));
    console.log(`Snapshot #${id} deleted.`);
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
