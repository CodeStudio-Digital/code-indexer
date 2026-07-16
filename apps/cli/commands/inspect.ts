import type { Command } from 'commander';
import { getDB } from '../helpers.js';

export function register(program: Command): void {
  program.command('file <project> <path>').description('Show file details').action((projectName: string, filePath: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const file = db.getFile(project.id, filePath);
    if (!file) { console.error('File not found'); process.exit(1); }
    console.log(`Path: ${file.path}\nLanguage: ${file.language}\nLines: ${file.line_count}\nBytes: ${file.size}`);
    const symbols = db.getSymbolsByFile(project.id, filePath);
    if (symbols.length > 0) {
      console.log(`\nSymbols (${symbols.length}):`);
      for (const s of symbols) { console.log(`  ${s.kind} ${s.name} — ${s.signature}`); }
    }
    db.close();
  });

  program.command('symbol <id>').description('Show symbol details').option('-p, --project <name>', 'Project name (needed when per-project DBs are split)').action((id: string, opts: { project?: string }) => {
    const db = getDB();
    // Post-split the surrogate id is unique only within a project DB; --project
    // routes the lookup there. Absent → central (pre-split behavior).
    const project = opts.project ? db.getProjectByName(opts.project) : undefined;
    const sym = db.getSymbolById(parseInt(id, 10), project?.id);
    if (!sym) { console.error('Symbol not found'); process.exit(1); }
    console.log(`Name: ${sym.name}\nKind: ${sym.kind}\nSignature: ${sym.signature}`);
    console.log(`File: ${sym.file_path}:${sym.line ?? '?'}\nParent: ${sym.parent ?? '-'}`);
    console.log(`Comment: ${sym.comment ?? '-'}\nTags: ${JSON.parse(sym.tags).join(', ')}`);
    db.close();
  });

  program.command('class <name>').description('Show class members').option('-p, --project <name>', 'Project name').action((name: string, opts: { project?: string }) => {
    const db = getDB();
    const project = db.resolveProject(opts.project);
    const members = db.getClassMembers(name, project.id);
    if (members.length === 0) { console.log('No members found'); } else {
      for (const m of members) { console.log(`  ${m.kind} ${m.name} — ${m.signature}`); }
    }
    db.close();
  });

  program.command('stats <project>').description('Show project stats').action((projectName: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const stats = db.getStats(project.id);
    console.log(JSON.stringify(stats, null, 2));
    db.close();
  });

  program.command('runs <project>').description('Show indexing runs').action((projectName: string) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const runs = db.getRuns(project.id);
    for (const r of runs) {
      console.log(`  #${r.id} structural ${r.status} | ${r.started_at} | ${r.indexed_files}/${r.total_files} files | errors ${r.error_count}`);
    }
    db.close();
  });

  program.command('list <project>').description('List files').option('-l, --language <lang>', 'Filter by language').action((projectName: string, opts: { language?: string }) => {
    const db = getDB();
    const project = db.getProjectByName(projectName);
    if (!project) { console.error('Project not found'); process.exit(1); }
    const files = db.listFiles(project.id, opts.language);
    for (const f of files) { console.log(`  ${f.path} (${f.language}, ${f.line_count} lines)`); }
    db.close();
  });
}
