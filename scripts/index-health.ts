/**
 * Index health CLI — sanity report over a live project index.
 *
 *   npx tsx scripts/index-health.ts --project <name|id> [--db <path>]
 *
 * Requires the NODE ABI for better-sqlite3 (app closed + `pnpm node:rebuild`;
 * give it back with `pnpm electron:rebuild`).
 */
import { resolve } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg('db')
  ?? process.env.MCP_DB_PATH
  ?? resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.mcp-code-indexer/index.db');
const projectArg = arg('project');
if (!projectArg) {
  console.error('Usage: npx tsx scripts/index-health.ts --project <name|id> [--db <path>]');
  process.exit(1);
}

const db = new CodeIndexDB(dbPath);
try {
  const project = /^\d+$/.test(projectArg)
    ? db.getProject(Number(projectArg))
    : db.getProjectByName(projectArg);
  if (!project) {
    console.error(`Project '${projectArg}' not found in ${dbPath}`);
    console.error(`Known projects: ${db.listProjects().map((p) => `${p.id}:${p.name}`).join(', ')}`);
    process.exit(1);
  }

  const r = db.indexHealthReport(project.id);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

  console.log(`# Index health — ${project.name} (id ${project.id})`);
  console.log(`DB: ${dbPath}\n`);
  console.log(`Files: ${r.files} | Symbols: ${r.symbols} | References: ${r.references}`);
  console.log(`Dangling references (symbol_id NULL): ${r.danglingReferences} (${r.danglingReferencePct}%)`);
  console.log(`Unresolved internal deps: ${r.unresolvedInternalDeps}`);
  console.log(`Relations: extends=${r.relations.extends} implements=${r.relations.implements} mixes(traits)=${r.relations.mixes}\n`);

  console.log('Per language (files with ≥1 symbol / files · namespace coverage):');
  for (const l of r.perLanguage) {
    const ns = l.namespaceCoverage > 0 ? ` · ns ${l.namespaceCoverage}%` : '';
    console.log(`  ${l.language.padEnd(11)} ${String(l.filesWithSymbols).padStart(5)}/${String(l.files).padEnd(5)} (${pct(l.filesWithSymbols, l.files)}) · ${l.symbols} symbols${ns}`);
  }

  if (r.suspectFiles.length > 0) {
    console.log('\nParse-error suspects (extractable, >5 lines, ZERO symbols):');
    for (const f of r.suspectFiles) console.log(`  ${f.path} [${f.language}] ${f.line_count ?? '?'}L`);
  }
} finally {
  db.close();
}
