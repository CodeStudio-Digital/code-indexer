import type { Command } from 'commander';
import { getDB } from '../helpers.js';
import { printUsageTree } from '../format.js';

export function register(program: Command): void {
  program.command('deps <project> <file>').description('Show file dependencies').action((projectName: string, filePath: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const file = db.getFile(project.id, filePath);
    if (!file) { console.error('File not found'); process.exit(1); }
    const deps = db.getDependencies(file.id);
    if (deps.length === 0) { console.log('No dependencies found.'); } else {
      for (const d of deps) { console.log(`  [${d.dep_type}] ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`); }
    }
    db.close();
  });

  program.command('dependents <project> <file>').description('Show files that depend on a file').action((projectName: string, filePath: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const file = db.getFile(project.id, filePath);
    if (!file) { console.error('File not found'); process.exit(1); }
    const deps = db.getDependents(project.id, file.id);
    if (deps.length === 0) { console.log('No dependents found.'); } else {
      for (const d of deps) { console.log(`  ${d.source_file_path} (${d.import_path})`); }
    }
    db.close();
  });

  program.command('references <project> <symbol>').description('Find symbol references').action((projectName: string, symbolName: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const refs = db.getSymbolCallers(project.id, symbolName);
    if (refs.length === 0) { console.log('No references found.'); } else {
      for (const r of refs) { console.log(`  ${r.referencing_file_path}:${r.line ?? '?'} — ${r.context ?? ''}`); }
    }
    db.close();
  });

  program.command('hierarchy <project> <symbol>').description('Show symbol hierarchy').action((projectName: string, symbolName: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const h = db.getSymbolHierarchy(project.id, symbolName);
    if (h.extends_chain.length > 0) console.log(`Extends: ${h.extends_chain.join(' → ')}`);
    if (h.implements_list.length > 0) console.log(`Implements: ${h.implements_list.join(', ')}`);
    if (h.subclasses.length > 0) console.log(`Subclasses: ${h.subclasses.join(', ')}`);
    if (h.implementors.length > 0) console.log(`Implementors: ${h.implementors.join(', ')}`);
    if (h.extends_chain.length === 0 && h.implements_list.length === 0 && h.subclasses.length === 0 && h.implementors.length === 0) {
      console.log('No hierarchy information found.');
    }
    db.close();
  });

  program.command('trace <project> <symbol>').description('Trace symbol usage tree').option('-d, --depth <n>', 'Max depth', parseInt, 3)
    .action((projectName: string, symbolName: string, opts: { depth: number }) => {
      const db = getDB();
      const project = db.getProjectByName(projectName);
      if (!project) { console.error('Project not found'); process.exit(1); }
      const tree = db.traceSymbolUsage(project.id, symbolName, opts.depth);

      console.log(`Symbol: ${tree.symbol}`);
      console.log(`Defined in: ${tree.defined_in ?? 'not found'}`);

      if (tree.callers.length === 0) {
        console.log('No usages found.');
      } else {
        console.log('\nUsage tree:');
        printUsageTree(tree.callers as Parameters<typeof printUsageTree>[0], '  ');
      }
      db.close();
    });
}
